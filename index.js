import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import Bottleneck from 'bottleneck';
import pg from 'pg';
import { createPersistenceService } from './db-persistence.js';

config();

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const GITHUB_TOKEN = (process.env.ITHUB_TOKEN || '').trim();
const MODE = process.argv[2] || 'fetch';
const PERSIST_BATCH_FILE = process.argv[3] || null;

if (MODE === 'fetch' && !GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is required for fetch mode. Put it in .env or your CI secrets.');
}

const GSOC_DIR = path.resolve(__dirname, process.env.GSOC_DIR || './GSoC');
const USE_OLD_RECORDS = parseBoolean(process.env.USE_OLD_RECORDS, false);
const WRITE_LEGACY_JSON = parseBoolean(process.env.WRITE_LEGACY_JSON, true);
const ACTIVITY_REPO_LIMIT = toPositiveInteger(process.env.ACTIVITY_REPO_LIMIT, 3);
const GITHUB_MIN_TIME_MS = toPositiveInteger(process.env.ITHUBMIN_TIME_MS, 2000);
const GITHUB_MAX_CONCURRENT = toPositiveInteger(process.env.ITHUB_MAX_CONCURRENT, 1);
const MAX_GITHUB_RETRIES = toNonNegativeInteger(process.env.MAX_GITHUB_RETRIES, 3);

// Set to 0 to fetch every page.
const MAX_REPO_PAGES = toNonNegativeInteger(process.env.MAX_REPO_PAGES, 1);
const MAX_CONTRIBUTOR_PAGES = toNonNegativeInteger(process.env.MAX_CONTRIBUTOR_PAGES, 1);

const LEGACY_FRONTEND_DATA_DIR = path.resolve(
    __dirname,
    process.env.LEGACY_FRONTEND_DATA_DIR || '../organization-selection-tool/src/data'
);
const LEGACY_DETAILS_DIR = path.join(LEGACY_FRONTEND_DATA_DIR, 'OrganizationsDetails(GSoC)');
const LEGACY_COMPILED_DIR = path.join(LEGACY_FRONTEND_DATA_DIR, 'CompiledData');

const CACHE_FILES = {
    orgNames: path.join(__dirname, 'github-id-and-orgnames.json'),
    repos: path.join(__dirname, 'github-id-and-repos.json'),
    contributors: path.join(__dirname, 'github-id-and-contributors.json'),
    commits: path.join(__dirname, 'github-id-and-commits-count-hashmap.json')
};

console.log('GitHub token configured:', Boolean(GITHUB_TOKEN));
const githubHeaders = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gsoc-hub-data-compiler'
};

const limiter = new Bottleneck({
    maxConcurrent: GITHUB_MAX_CONCURRENT,
    minTime: GITHUB_MIN_TIME_MS
});

const pool = createDatabasePool();

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

function parseBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return ['true', '1', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function toPositiveInteger(value, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function toNonNegativeInteger(value, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function normalizeArray(value) {
    if (Array.isArray(value)) {
        return value
            .filter(item => item !== null && item !== undefined)
            .map(item => String(item).trim())
            .filter(Boolean);
    }

    if (value === null || value === undefined) return [];

    const normalized = String(value).trim();
    return normalized ? [normalized] : [];
}

function uniqueCaseInsensitive(values) {
    const map = new Map();

    for (const value of normalizeArray(values)) {
        const key = value.toLowerCase();
        if (!map.has(key)) map.set(key, value);
    }

    return [...map.values()];
}

function normalizeGithubId(value) {
    if (value === null || value === undefined) return null;

    const normalized = String(value).trim();
    if (!normalized || normalized.toUpperCase() === 'NA') return null;

    return normalized;
}

function githubIdForJson(value) {
    return normalizeGithubId(value) || 'NA';
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function maxYear(org) {
    const years = Array.isArray(org.year) ? org.year : [];
    return years.length > 0 ? Math.max(...years.map(Number).filter(Number.isFinite)) : 0;
}

function cleanFilePart(value) {
    const cleaned = String(value ?? '')
        .replace(/[^a-zA-Z0-9 ]/g, '')
        .trim()
        .replace(/\s+/g, '');

    return cleaned || 'NA';
}

function detailFileName(org) {
    return `${cleanFilePart(org.name)}_${cleanFilePart(githubIdForJson(org.githubID))}.json`;
}

function createDatabasePool() {
    const sslEnabled = parseBoolean(process.env.DB_SSL, false);
    const ssl = sslEnabled ? { rejectUnauthorized: false } : false;

    if (process.env.NEON_DATABASE_URL) {
        return new Pool({
            connectionString: process.env.NEON_DATABASE_URL,
            ssl
        });
    }

    return new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME || 'gsoc',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        ssl
    });
}

async function readJsonFile(filePath, fallback = null) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT' && fallback !== null) return fallback;
        throw error;
    }
}

async function writeJsonFile(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

// -----------------------------------------------------------------------------
// Dynamic GSoC-year discovery
// -----------------------------------------------------------------------------

async function discoverGsocYears() {
    const entries = await fs.readdir(GSOC_DIR, { withFileTypes: true });

    const years = entries
        .filter(entry => entry.isFile() && /^\d{4}\.json$/.test(entry.name))
        .map(entry => Number.parseInt(path.basename(entry.name, '.json'), 10))
        .filter(Number.isInteger)
        .sort((a, b) => a - b);

    if (years.length === 0) {
        throw new Error(`No YYYY.json files found in ${GSOC_DIR}`);
    }

    return years;
}

function gsocJsonFilePath(year) {
    return path.join(GSOC_DIR, `${year}.json`);
}

// -----------------------------------------------------------------------------
// Historical GSoC merge - preserves the intent of your original compiler.
// A second canonical merge by name + githubID is done after GitHub resolution.
// -----------------------------------------------------------------------------

class OrganizationData {
    parentOrganizationsData = {};
    idAndURLHashMap = {};
    totalCategories = new Set();
    totalTopics = new Set();
    totalTechnologies = new Set();

    _normalizedIdText(value) {
        return String(value ?? '')
            .toLowerCase()
            .replace(/[^a-zA-Z\d ]/g, '')
            .split(' ')
            .join('');
    }

    _getIdFromOrgName(name, url, description) {
        const idName = this._normalizedIdText(name);
        const idDescription = this._normalizedIdText(description);
        const idURL = String(url ?? '').match(/https?:\/\/(?:www\.)?([^/]+)/i)?.[1]?.toLowerCase();

        if (idURL && this.idAndURLHashMap[idURL]) return this.idAndURLHashMap[idURL];
        if (idName && this.idAndURLHashMap[idName]) return this.idAndURLHashMap[idName];
        if (idDescription && this.idAndURLHashMap[idDescription]) return this.idAndURLHashMap[idDescription];

        const canonicalId = idName || idURL || idDescription;
        if (!canonicalId) {
            throw new Error(`Unable to build compiler identity for organization: ${name}`);
        }

        if (idName) this.idAndURLHashMap[idName] = canonicalId;
        if (idDescription) this.idAndURLHashMap[idDescription] = canonicalId;

        if (
            idURL &&
            idURL !== 'github.com' &&
            idURL !== 'docs.google.com' &&
            idURL !== 'summerofcode.withgoogle.com'
        ) {
            this.idAndURLHashMap[idURL] = canonicalId;
        }

        return canonicalId;
    }

    _mergeChanges(id, obj, year) {
        const target = this.parentOrganizationsData[id];

        // Years are processed ascending, so later-year non-empty metadata wins.
        for (const field of [
            'image_url',
            'image_background_color',
            'description',
            'name',
            'url',
            'irc_channel',
            'contact_email',
            'mailing_list',
            'twitter_url',
            'blog_url',
            'facebook_url'
        ]) {
            if (obj[field] !== null && obj[field] !== undefined && obj[field] !== '') {
                target[field] = obj[field];
            }
        }

        target.category = uniqueCaseInsensitive([
            ...target.category,
            ...normalizeArray(obj.category)
        ]);

        target.topics = uniqueCaseInsensitive([
            ...target.topics,
            ...normalizeArray(obj.topics)
        ]);

        target.technologies = uniqueCaseInsensitive([
            ...target.technologies,
            ...normalizeArray(obj.technologies)
        ]);

        target.year = [...new Set([...target.year, year])].sort((a, b) => a - b);
        target.projects[year] = Array.isArray(obj.projects) ? obj.projects : [];
    }

    add(obj, year) {
        if (!obj?.name) return;

        const id = this._getIdFromOrgName(obj.name, obj.url, obj.description);

        for (const category of normalizeArray(obj.category)) this.totalCategories.add(category);
        for (const topic of normalizeArray(obj.topics)) this.totalTopics.add(topic);
        for (const technology of normalizeArray(obj.technologies)) this.totalTechnologies.add(technology);

        if (this.parentOrganizationsData[id]) {
            this._mergeChanges(id, obj, year);
            return;
        }

        this.parentOrganizationsData[id] = {
            name: obj.name,
            image_url: obj.image_url || null,
            image_background_color: obj.image_background_color || null,
            description: obj.description || null,
            url: obj.url || null,
            category: uniqueCaseInsensitive(obj.category),
            topics: uniqueCaseInsensitive(obj.topics),
            technologies: uniqueCaseInsensitive(obj.technologies),
            irc_channel: obj.irc_channel || null,
            contact_email: obj.contact_email || null,
            mailing_list: obj.mailing_list || null,
            twitter_url: obj.twitter_url || null,
            blog_url: obj.blog_url || null,
            facebook_url: obj.facebook_url || null,
            year: [year],
            projects: {
                [year]: Array.isArray(obj.projects) ? obj.projects : []
            }
        };
    }
}

async function fetchOrganizationsData(compiledOrgsData, gsocYears) {
    for (const year of gsocYears) {
        const filePath = gsocJsonFilePath(year);
        const data = await readJsonFile(filePath);

        if (!Array.isArray(data.organizations)) {
            throw new Error(`${filePath} does not contain an organizations array.`);
        }

        for (const orgObj of data.organizations) {
            compiledOrgsData.add(orgObj, year);
        }

        console.log(`Loaded ${data.organizations.length} organizations from ${year}.`);
    }
}

function objectSorter(object) {
    return Object.keys(object)
        .sort()
        .reduce((finalObject, key) => {
            finalObject[key] = object[key];
            return finalObject;
        }, {});
}

// -----------------------------------------------------------------------------
// GitHub API
// -----------------------------------------------------------------------------

async function githubRequest(url, { allow202Retry = false } = {}) {
    return limiter.schedule(async () => {
        let lastError;

        for (let attempt = 0; attempt <= MAX_GITHUB_RETRIES; attempt++) {
            try {
                const response = await fetch(url, { headers: githubHeaders });
                const remaining = response.headers.get('x-ratelimit-remaining');
                const resetSeconds = Number(response.headers.get('x-ratelimit-reset'));
                const reset = Number.isFinite(resetSeconds)
                    ? new Date(resetSeconds * 1000).toISOString()
                    : 'unknown';

                console.log(
                    `GitHub ${response.status} | remaining=${remaining ?? 'unknown'} | reset=${reset} | ${url.pathname}`
                );

                if (allow202Retry && response.status === 202 && attempt < MAX_GITHUB_RETRIES) {
                    await sleep(2000 * (attempt + 1));
                    continue;
                }

                if (response.status === 204) return null;

                if (!response.ok) {
                    const body = await response.text();
                    const error = new Error(
                        `GitHub HTTP ${response.status}: ${body.slice(0, 500)}`
                    );
                    error.status = response.status;
                    throw error;
                }

                return await response.json();
            } catch (error) {
                lastError = error;

                const retryable =
                    !error.status ||
                    error.status === 202 ||
                    error.status === 403 ||
                    error.status === 429 ||
                    error.status >= 500;

                if (!retryable || attempt >= MAX_GITHUB_RETRIES) break;

                await sleep(2000 * (attempt + 1));
            }
        }

        throw lastError;
    });
}

async function findOrganizationIDWithNameGiven(orgName, orgNameToGithubId) {
    if (hasOwn(orgNameToGithubId, orgName)) {
        const cached = String(orgNameToGithubId[orgName] ?? '').trim();
        if (cached && cached.toUpperCase() !== 'NA') return cached;
        if (cached.toUpperCase() === 'NA' && USE_OLD_RECORDS) return 'NA';
    }

    const url = new URL('https://api.github.com/search/users');
    url.searchParams.set('q', `${orgName} type:org`);
    url.searchParams.set('per_page', '1');

    try {
        const data = await githubRequest(url);

        if (data?.total_count > 0 && data.items?.[0]?.login) {
            console.log(`Resolved GitHub organization: ${orgName} -> ${data.items[0].login}`);
            return data.items[0].login;
        }

        console.log(`No GitHub organization found for: ${orgName}`);
        return 'NA';
    } catch (error) {
        console.error(`Error resolving GitHub ID for ${orgName}: ${error.message}`);
        // Do not persist an empty string. NA is normalized to SQL NULL by the DB layer.
        return 'NA';
    }
}

async function fetchPaginated(url, maxPages = 0) {
    const all = [];
    let page = 1;

    while (true) {
        url.searchParams.set('per_page', '100');
        url.searchParams.set('page', String(page));

        const data = await githubRequest(url);
        if (!Array.isArray(data) || data.length === 0) break;

        all.push(...data);

        if (data.length < 100) break;
        if (maxPages > 0 && page >= maxPages) break;

        page++;
    }

    return all;
}

async function fetchOrgRepos(githubID, backupReposMap) {
    const normalizedGithubId = normalizeGithubId(githubID);
    if (!normalizedGithubId) return [];

    if (
        USE_OLD_RECORDS &&
        hasOwn(backupReposMap, normalizedGithubId) &&
        Array.isArray(backupReposMap[normalizedGithubId])
    ) {
        return backupReposMap[normalizedGithubId];
    }

    const url = new URL(`https://api.github.com/orgs/${encodeURIComponent(normalizedGithubId)}/repos`);
    url.searchParams.set('sort', 'pushed');
    url.searchParams.set('direction', 'desc');

    try {
        const data = await fetchPaginated(url, MAX_REPO_PAGES);

        return data.map(repo => ({
            id: repo.id,
            node_id: repo.node_id,
            name: repo.name,
            full_name: repo.full_name,
            html_url: repo.html_url,
            description: repo.description,
            language: repo.language,
            stargazers_count: repo.stargazers_count ?? 0,
            forks_count: repo.forks_count ?? 0,
            open_issues_count: repo.open_issues_count ?? 0,
            license: repo.license,
            topics: Array.isArray(repo.topics) ? repo.topics : []
        }));
    } catch (error) {
        console.error(`Error fetching repositories for ${normalizedGithubId}: ${error.message}`);
        return [];
    }
}

async function fetchCalculateOrgActivity(githubID, repoName) {
    const url = new URL(
        `https://api.github.com/repos/${encodeURIComponent(githubID)}/${encodeURIComponent(repoName)}/stats/participation`
    );

    try {
        const data = await githubRequest(url, { allow202Retry: true });
        if (!data) return 0;

        return Array.isArray(data.all)
            ? data.all.reduce((result, item) => result + Number(item || 0), 0)
            : 0;
    } catch (error) {
        console.error(`Error fetching activity for ${githubID}/${repoName}: ${error.message}`);
        return 0;
    }
}

async function fetchContributorsDetails(githubID, repoName) {
    const url = new URL(
        `https://api.github.com/repos/${encodeURIComponent(githubID)}/${encodeURIComponent(repoName)}/contributors`
    );

    try {
        const data = await fetchPaginated(url, MAX_CONTRIBUTOR_PAGES);

        return data
            .filter(contributor => contributor?.login && contributor?.id)
            .map(contributor => ({
                login: contributor.login,
                id: contributor.id,
                node_id: contributor.node_id,
                avatar_url: contributor.avatar_url,
                html_url: contributor.html_url,
                contributions: contributor.contributions ?? 0
            }));
    } catch (error) {
        console.error(`Error fetching contributors for ${githubID}/${repoName}: ${error.message}`);
        return [];
    }
}

function aggregateContributors(contributors) {
    const byUser = new Map();

    for (const contributor of contributors) {
        if (!contributor?.id || !contributor?.login) continue;

        const key = String(contributor.id);
        const existing = byUser.get(key);

        if (!existing) {
            byUser.set(key, {
                ...contributor,
                contributions: Number(contributor.contributions || 0)
            });
        } else {
            existing.contributions += Number(contributor.contributions || 0);
            // Keep the most recent non-empty GitHub metadata.
            existing.login = contributor.login || existing.login;
            existing.node_id = contributor.node_id || existing.node_id;
            existing.avatar_url = contributor.avatar_url || existing.avatar_url;
            existing.html_url = contributor.html_url || existing.html_url;
        }
    }

    return [...byUser.values()].sort((a, b) => b.contributions - a.contributions);
}

async function enrichOrganizationWithGithub(org, caches, runtimeGithubCache) {
    const githubID = await findOrganizationIDWithNameGiven(org.name, caches.orgNames);
    const githubJsonId = githubIdForJson(githubID);

    caches.orgNames[org.name] = githubJsonId;
    org.githubID = githubJsonId;

    if (!normalizeGithubId(githubJsonId)) {
        org.repositories = [];
        org.contributorsDetails = [];
        org.totalCommits = 0;
        org.activeOrg = false;
        return org;
    }

    // Multiple GSoC names may share one GitHub org ID (e.g. google).
    // Reuse the same GitHub API result within this run.
    if (runtimeGithubCache.has(githubJsonId)) {
        const cached = runtimeGithubCache.get(githubJsonId);
        org.repositories = cached.repositories;
        org.contributorsDetails = cached.contributors;
        org.totalCommits = cached.totalCommits;
        org.activeOrg = cached.activeOrg;
        return org;
    }

    const repositories = await fetchOrgRepos(githubJsonId, caches.repos);
    let totalCommits = 0;
    let contributors = [];

    const activityRepos = repositories.slice(0, ACTIVITY_REPO_LIMIT);

    if (USE_OLD_RECORDS && hasOwn(caches.commits, githubJsonId)) {
        totalCommits = Number(caches.commits[githubJsonId] || 0);
    } else {
        for (const repo of activityRepos) {
            totalCommits += await fetchCalculateOrgActivity(githubJsonId, repo.name);
        }
    }

    if (
        USE_OLD_RECORDS &&
        hasOwn(caches.contributors, githubJsonId) &&
        Array.isArray(caches.contributors[githubJsonId])
    ) {
        contributors = caches.contributors[githubJsonId];
    } else {
        const rawContributors = [];
        for (const repo of activityRepos) {
            rawContributors.push(...await fetchContributorsDetails(githubJsonId, repo.name));
        }
        contributors = aggregateContributors(rawContributors);
    }

    const activeOrg = totalCommits >= 52 * 7;

    caches.repos[githubJsonId] = repositories;
    caches.contributors[githubJsonId] = contributors;
    caches.commits[githubJsonId] = totalCommits;

    const githubData = {
        repositories,
        contributors,
        totalCommits,
        activeOrg
    };

    runtimeGithubCache.set(githubJsonId, githubData);

    org.repositories = repositories;
    org.contributorsDetails = contributors;
    org.totalCommits = totalCommits;
    org.activeOrg = activeOrg;

    return org;
}

// -----------------------------------------------------------------------------
// Canonical merge using the identity rule you chose:
// githubID present -> name + githubID
// githubID missing/NA -> name
// -----------------------------------------------------------------------------

function databaseIdentityKey(org) {
    const name = String(org.name ?? '').trim().toLowerCase();
    const githubID = normalizeGithubId(org.githubID);

    if (githubID) {
        return `org::${name}::github::${githubID.toLowerCase()}`;
    }

    return `org::${name}`;
}

function projectIdentity(project) {
    if (project?.proposal_id) return `proposal:${project.proposal_id}`;
    if (project?.project_url) return `url:${project.project_url}`;

    return `fallback:${String(project?.title ?? '').trim().toLowerCase()}::${String(
        project?.student_name ?? ''
    ).trim().toLowerCase()}`;
}

function mergeProjectArrays(left = [], right = []) {
    const map = new Map();

    for (const project of [...left, ...right]) {
        if (!project) continue;
        map.set(projectIdentity(project), project);
    }

    return [...map.values()];
}

function mergeCanonicalOrganization(base, incoming) {
    const baseNewestYear = maxYear(base);
    const incomingNewestYear = maxYear(incoming);
    const incomingIsNewer = incomingNewestYear >= baseNewestYear;

    const primary = incomingIsNewer ? incoming : base;
    const secondary = incomingIsNewer ? base : incoming;

    for (const field of [
        'name',
        'image_url',
        'image_background_color',
        'description',
        'url',
        'irc_channel',
        'contact_email',
        'mailing_list',
        'twitter_url',
        'blog_url',
        'facebook_url',
        'githubID'
    ]) {
        base[field] = primary[field] || secondary[field] || null;
    }

    base.category = uniqueCaseInsensitive([...base.category, ...incoming.category]);
    base.topics = uniqueCaseInsensitive([...base.topics, ...incoming.topics]);
    base.technologies = uniqueCaseInsensitive([...base.technologies, ...incoming.technologies]);
    base.year = [...new Set([...base.year, ...incoming.year])].sort((a, b) => a - b);

    const allProjectYears = new Set([
        ...Object.keys(base.projects || {}),
        ...Object.keys(incoming.projects || {})
    ]);

    for (const year of allProjectYears) {
        base.projects[year] = mergeProjectArrays(
            base.projects?.[year] || [],
            incoming.projects?.[year] || []
        );
    }

    // Same identity => same GitHub enrichment. Prefer a non-empty snapshot.
    if ((incoming.repositories?.length || 0) > (base.repositories?.length || 0)) {
        base.repositories = incoming.repositories;
    }

    if ((incoming.contributorsDetails?.length || 0) > (base.contributorsDetails?.length || 0)) {
        base.contributorsDetails = incoming.contributorsDetails;
    }

    base.totalCommits = Math.max(Number(base.totalCommits || 0), Number(incoming.totalCommits || 0));
    base.activeOrg = Boolean(base.activeOrg || incoming.activeOrg);

    return base;
}

function canonicalizeOrganizations(organizations) {
    const map = new Map();

    for (const org of organizations) {
        const key = databaseIdentityKey(org);

        if (!map.has(key)) {
            map.set(key, structuredClone(org));
        } else {
            mergeCanonicalOrganization(map.get(key), org);
        }
    }

    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// -----------------------------------------------------------------------------
// PostgreSQL persistence
// Bulk/resumable persistence lives in db-persistence.js.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Backward-compatible JSON output
// -----------------------------------------------------------------------------

async function clearGeneratedDetailJsonFiles() {
    try {
        const entries = await fs.readdir(LEGACY_DETAILS_DIR, { withFileTypes: true });
        await Promise.all(
            entries
                .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
                .map(entry => fs.unlink(path.join(LEGACY_DETAILS_DIR, entry.name)))
        );
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function writeLegacyOutputs(organizations, gsocYears, sourceTotals, caches) {
    if (!WRITE_LEGACY_JSON) return;

    await fs.mkdir(LEGACY_DETAILS_DIR, { recursive: true });
    await fs.mkdir(LEGACY_COMPILED_DIR, { recursive: true });
    await clearGeneratedDetailJsonFiles();

    const summary = [];

    for (const org of organizations) {
        const detailCopy = structuredClone(org);
        delete detailCopy.totalCommits; // preserve your public detailed-JSON shape

        await writeJsonFile(
            path.join(LEGACY_DETAILS_DIR, detailFileName(detailCopy)),
            detailCopy
        );

        summary.push({
            name: org.name,
            image_url: org.image_url,
            image_background_color: org.image_background_color,
            description: org.description,
            url: org.url,
            category: org.category,
            topics: org.topics,
            technologies: org.technologies,
            year: org.year,
            githubID: githubIdForJson(org.githubID),
            activeOrg: Boolean(org.activeOrg)
        });
    }

    await writeJsonFile(CACHE_FILES.commits, caches.commits);
    await writeJsonFile(CACHE_FILES.contributors, caches.contributors);
    await writeJsonFile(CACHE_FILES.repos, caches.repos);
    await writeJsonFile(CACHE_FILES.orgNames, caches.orgNames);

    await writeJsonFile(
        path.join(LEGACY_COMPILED_DIR, 'organizations.json'),
        {
            orgData: summary,
            totalGsocYears: gsocYears,
            totalCategories: sourceTotals.categories,
            totalTopics: sourceTotals.topics,
            totalTechnologies: sourceTotals.technologies
        }
    );

    console.log('Legacy JSON files saved.');
}

// -----------------------------------------------------------------------------
// Sync run tracking
// -----------------------------------------------------------------------------

async function createSyncRun() {
    const result = await pool.query(
        `
        INSERT INTO data_sync_runs (source, status)
        VALUES ('GSOC_GITHUB', 'RUNNING')
        RETURNING id;
        `
    );

    return result.rows[0].id;
}

async function finishSyncRun(syncRunId, status, recordsProcessed, errorMessage = null) {
    if (!syncRunId) return;

    await pool.query(
        `
        UPDATE data_sync_runs
        SET status = $2,
            records_processed = $3,
            error_message = $4,
            finished_at = CURRENT_TIMESTAMP
        WHERE id = $1;
        `,
        [syncRunId, status, recordsProcessed, errorMessage]
    );
}

// -----------------------------------------------------------------------------
// Main compile + refresh pipeline
// -----------------------------------------------------------------------------

async function loadCaches() {
    return {
        orgNames: await readJsonFile(CACHE_FILES.orgNames, {}),
        repos: await readJsonFile(CACHE_FILES.repos, {}),
        contributors: await readJsonFile(CACHE_FILES.contributors, {}),
        commits: await readJsonFile(CACHE_FILES.commits, {})
    };
}

async function compileDataFetch() {
    let syncRunId = null;
    let canonicalOrganizations = [];

    try {
        await pool.query('SELECT 1;');
        console.log('PostgreSQL connection successful.');

        syncRunId = await createSyncRun();

        const gsocYears = await discoverGsocYears();
        console.log(`Discovered GSoC years dynamically: ${gsocYears.join(', ')}`);

        const compiledOrgsData = new OrganizationData();
        await fetchOrganizationsData(compiledOrgsData, gsocYears);

        const sortedCompiledOrgsData = objectSorter(compiledOrgsData.parentOrganizationsData);
        const organizations = Object.values(sortedCompiledOrgsData);

        console.log(`Historical compiler produced ${organizations.length} candidate organizations.`);

        const caches = await loadCaches();
        const runtimeGithubCache = new Map();
        const enrichedOrganizations = [];

        // IMPORTANT: GitHub enrichment remains exactly sequential.
        for (let i = 0; i < organizations.length; i++) {
            const org = organizations[i];
            console.log(`\n[${i + 1}/${organizations.length}] Enriching ${org.name}`);

            enrichedOrganizations.push(
                await enrichOrganizationWithGithub(org, caches, runtimeGithubCache)
            );
        }

        canonicalOrganizations = canonicalizeOrganizations(enrichedOrganizations);

        console.log(
            `Canonical identity merge: ${enrichedOrganizations.length} -> ` +
            `${canonicalOrganizations.length} organizations.`
        );

        const outputDir = path.resolve(__dirname, 'output');
        const batchDir = path.join(outputDir, 'batches');

        await fs.rm(outputDir, { recursive: true, force: true });
        await fs.mkdir(batchDir, { recursive: true });

        const batchSize = toPositiveInteger(process.env.DB_BATCH_SIZE, 100);
        const batches = [];

        for (let i = 0; i < canonicalOrganizations.length; i += batchSize) {
            const batch = canonicalOrganizations.slice(i, i + batchSize);
            const batchNumber = Math.floor(i / batchSize);
            const fileName = `batch-${String(batchNumber).padStart(3, '0')}.json`;

            await writeJsonFile(path.join(batchDir, fileName), batch);

            batches.push({
                file: fileName,
                count: batch.length
            });
        }

        // The complete enriched dataset is useful for the final output stage and
        // gives us a reproducible snapshot independent of the DB jobs.
        await writeJsonFile(
            path.join(outputDir, 'enriched-organizations.json'),
            canonicalOrganizations
        );

        await writeJsonFile(
            path.join(outputDir, 'metadata.json'),
            {
                syncRunId,
                gsocYears,
                batchSize,
                organizationCount: canonicalOrganizations.length,
                batches,
                sourceTotals: {
                    categories: [...compiledOrgsData.totalCategories],
                    topics: [...compiledOrgsData.totalTopics],
                    technologies: [...compiledOrgsData.totalTechnologies]
                }
            }
        );

        // Save the refreshed caches into the artifact. The DB jobs do not need
        // GitHub access and do not modify these files.
        await writeJsonFile(path.join(outputDir, 'github-id-and-orgnames.json'), caches.orgNames);
        await writeJsonFile(path.join(outputDir, 'github-id-and-repos.json'), caches.repos);
        await writeJsonFile(path.join(outputDir, 'github-id-and-contributors.json'), caches.contributors);
        await writeJsonFile(path.join(outputDir, 'github-id-and-commits-count-hashmap.json'), caches.commits);

        console.log('\n========================================');
        console.log('Fetch + compile stage completed.');
        console.log(`Organizations: ${canonicalOrganizations.length}`);
        console.log(`Batches: ${batches.length}`);
        console.log(`Batch size: ${batchSize}`);
        console.log(`Sync run: ${syncRunId}`);
        console.log('========================================');
    } catch (error) {
        console.error('\nFetch + compile stage failed:');
        console.error(error);

        if (syncRunId) {
            try {
                await finishSyncRun(
                    syncRunId,
                    'FAILED',
                    canonicalOrganizations.length,
                    String(error?.stack || error?.message || error).slice(0, 10000)
                );
            } catch (syncError) {
                console.error(`Unable to mark sync run as FAILED: ${syncError.message}`);
            }
        }

        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

async function persistBatchMode(batchFile) {
    if (!batchFile) {
        throw new Error('Usage: node index.js persist <batch-file>');
    }

    const organizations = await readJsonFile(path.resolve(batchFile));

    if (!Array.isArray(organizations)) {
        throw new Error(`Batch file must contain a JSON array: ${batchFile}`);
    }

    const persistence = createPersistenceService(pool);

    console.log(`Persisting ${organizations.length} organizations from ${batchFile}`);

    const result = await persistence.persistBatch(organizations);

    const resultFile = process.env.BATCH_RESULT_FILE
        ? path.resolve(process.env.BATCH_RESULT_FILE)
        : path.resolve(
            path.dirname(batchFile),
            `${path.basename(batchFile, '.json')}-result.json`
        );

    await writeJsonFile(resultFile, {
        batchFile: path.basename(batchFile),
        requested: organizations.length,
        processed: result.processed,
        failures: result.failures
    });

    console.log(
        `Batch complete: ${result.processed}/${organizations.length} processed; ` +
        `${result.failures.length} failed.`
    );

    // Per-organization failures are intentionally recorded for the final stage.
    // The process itself remains successful so other matrix batches can continue.
    await pool.end();
}

async function finalizeMode() {
    const metadataPath = process.env.PIPELINE_METADATA
        ? path.resolve(process.env.PIPELINE_METADATA)
        : path.resolve(__dirname, 'output/metadata.json');

    const metadata = await readJsonFile(metadataPath);

    if (!metadata?.syncRunId) {
        throw new Error('metadata.json does not contain syncRunId.');
    }

    const persistence = createPersistenceService(pool);

    const resultFiles = process.env.BATCH_RESULT_DIR
        ? await fs.readdir(path.resolve(process.env.BATCH_RESULT_DIR))
        : [];

    const batchResults = [];

    for (const fileName of resultFiles) {
        if (!/\.json$/i.test(fileName) || !fileName.endsWith('-result.json')) continue;

        const filePath = path.join(
            path.resolve(process.env.BATCH_RESULT_DIR),
            fileName
        );

        try {
            batchResults.push(await readJsonFile(filePath));
        } catch (error) {
            console.warn(`Could not read batch result ${fileName}: ${error.message}`);
        }
    }

    const processed = batchResults.reduce(
        (sum, result) => sum + Number(result?.processed || 0),
        0
    );

    const failures = batchResults.flatMap(result =>
        Array.isArray(result?.failures) ? result.failures : []
    );

    const expected = Number(metadata.organizationCount || 0);
    const successful = processed === expected && failures.length === 0;

    // Never run authoritative global cleanup when one or more batches failed.
    // Otherwise repositories/contributors belonging to a failed organization
    // could be treated as orphans and deleted.
    if (successful) {
        await persistence.cleanupOrphans();
    }

    const enrichedOrganizationsPath = path.resolve(
        path.dirname(metadataPath),
        'enriched-organizations.json'
    );

    const enrichedOrganizations = await readJsonFile(enrichedOrganizationsPath, []);
    const artifactDir = path.dirname(metadataPath);
    const caches = {
        orgNames: await readJsonFile(path.join(artifactDir, 'github-id-and-orgnames.json'), {}),
        repos: await readJsonFile(path.join(artifactDir, 'github-id-and-repos.json'), {}),
        contributors: await readJsonFile(path.join(artifactDir, 'github-id-and-contributors.json'), {}),
        commits: await readJsonFile(path.join(artifactDir, 'github-id-and-commits-count-hashmap.json'), {})
    };

    const gsocYears = metadata.gsocYears || [];

    if (successful) {
        await writeLegacyOutputs(
            enrichedOrganizations,
            gsocYears,
            metadata.sourceTotals || {
                categories: [],
                topics: [],
                technologies: []
            },
            caches
        );
    }

    await finishSyncRun(
        metadata.syncRunId,
        successful ? 'SUCCESS' : 'FAILED',
        processed,
        successful
            ? null
            : JSON.stringify({
                expected,
                processed,
                failures
            }).slice(0, 10000)
    );

    if (!successful) {
        throw new Error(
            `Database synchronization incomplete: ${processed}/${expected} processed, ` +
            `${failures.length} organization failures.`
        );
    }

    console.log('\n========================================');
    console.log('Database finalization completed successfully.');
    console.log(`Organizations processed: ${processed}/${expected}`);
    console.log('Global orphan cleanup completed.');
    console.log('========================================');

    await pool.end();
}

async function main() {
    if (MODE === 'fetch') {
        await compileDataFetch();
        return;
    }

    if (MODE === 'persist') {
        await persistBatchMode(PERSIST_BATCH_FILE);
        return;
    }

    if (MODE === 'finalize') {
        await finalizeMode();
        return;
    }

    throw new Error(
        'Usage: node index.js fetch | node index.js persist <batch-file> | node index.js finalize'
    );
}

await main();
