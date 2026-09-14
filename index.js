import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import Bottleneck from 'bottleneck';
import pg from 'pg';

config();

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.ITHUB_TOKEN?.trim();
if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is required. Put it in .env or your CI secrets.');
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

console.log('GITHUB_TOKEN:', `Bearer ${GITHUB_TOKEN}`);
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
    return githubID ? `${name}::${githubID.toLowerCase()}` : `${name}::NO_GITHUB`;
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

async function findExistingOrganization(client, orgName, githubId) {
    if (githubId) {
        const exact = await client.query(
            `
            SELECT id, github_id
            FROM organizations
            WHERE LOWER(name) = LOWER($1)
              AND LOWER(github_id) = LOWER($2)
            LIMIT 1;
            `,
            [orgName, githubId]
        );

        if (exact.rows[0]) return exact.rows[0];

        // If an earlier run only knew the name (github_id NULL), upgrade that row
        // instead of creating a duplicate.
        const noGithub = await client.query(
            `
            SELECT id, github_id
            FROM organizations
            WHERE LOWER(name) = LOWER($1)
              AND github_id IS NULL
            LIMIT 1;
            `,
            [orgName]
        );

        if (noGithub.rows[0]) return noGithub.rows[0];

        return null;
    }

    // githubID == NA: name is the identity. If a previous run already resolved a
    // GitHub ID for that exact name, reuse the row and do NOT erase that ID.
    const byName = await client.query(
        `
        SELECT id, github_id
        FROM organizations
        WHERE LOWER(name) = LOWER($1)
        ORDER BY github_id NULLS LAST
        LIMIT 2;
        `,
        [orgName]
    );

    if (byName.rows.length > 1) {
        throw new Error(
            `Ambiguous organization identity for ${orgName}: githubID is NA but multiple rows share this name.`
        );
    }

    return byName.rows[0] || null;
}

async function upsertOrganization(client, org) {
    const githubId = normalizeGithubId(org.githubID);
    const existing = await findExistingOrganization(client, org.name, githubId);

    if (existing) {
        const result = await client.query(
            `
            UPDATE organizations
            SET name = $2,
                image_url = $3,
                image_background_color = $4,
                description = $5,
                url = $6,
                github_id = COALESCE($7, github_id),
                active_org = $8,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING id;
            `,
            [
                existing.id,
                org.name,
                org.image_url || null,
                org.image_background_color || null,
                org.description || null,
                org.url || null,
                githubId,
                Boolean(org.activeOrg)
            ]
        );

        return result.rows[0].id;
    }

    const result = await client.query(
        `
        INSERT INTO organizations (
            name,
            image_url,
            image_background_color,
            description,
            url,
            github_id,
            active_org
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id;
        `,
        [
            org.name,
            org.image_url || null,
            org.image_background_color || null,
            org.description || null,
            org.url || null,
            githubId,
            Boolean(org.activeOrg)
        ]
    );

    return result.rows[0].id;
}

async function replaceOrganizationContacts(client, organizationId, org) {
    await client.query(
        `
        INSERT INTO organization_contacts (
            organization_id,
            irc_channel,
            contact_email,
            mailing_list,
            twitter_url,
            blog_url,
            facebook_url
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (organization_id)
        DO UPDATE SET
            irc_channel = EXCLUDED.irc_channel,
            contact_email = EXCLUDED.contact_email,
            mailing_list = EXCLUDED.mailing_list,
            twitter_url = EXCLUDED.twitter_url,
            blog_url = EXCLUDED.blog_url,
            facebook_url = EXCLUDED.facebook_url;
        `,
        [
            organizationId,
            org.irc_channel || null,
            org.contact_email || null,
            org.mailing_list || null,
            org.twitter_url || null,
            org.blog_url || null,
            org.facebook_url || null
        ]
    );
}

async function replaceOrganizationYearsAndProjects(client, organizationId, org) {
    // gsoc_projects references organization_years with ON DELETE CASCADE.
    await client.query(
        'DELETE FROM organization_years WHERE organization_id = $1;',
        [organizationId]
    );

    const years = [...new Set((org.year || []).map(Number).filter(Number.isInteger))]
        .sort((a, b) => a - b);

    for (const year of years) {
        await client.query(
            `
            INSERT INTO organization_years (organization_id, year)
            VALUES ($1, $2);
            `,
            [organizationId, year]
        );

        const projects = Array.isArray(org.projects?.[year])
            ? org.projects[year]
            : Array.isArray(org.projects?.[String(year)])
                ? org.projects[String(year)]
                : [];

        for (const project of projects) {
            if (!project?.title) continue;

            await client.query(
                `
                INSERT INTO gsoc_projects (
                    organization_id,
                    year,
                    title,
                    short_description,
                    description,
                    student_name,
                    code_url,
                    proposal_id,
                    project_url
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
                `,
                [
                    organizationId,
                    year,
                    project.title,
                    project.short_description || null,
                    project.description || null,
                    project.student_name || null,
                    project.code_url || null,
                    project.proposal_id || null,
                    project.project_url || null
                ]
            );
        }
    }
}

async function upsertLookupValue(client, tableName, value) {
    const allowedTables = new Set(['categories', 'topics', 'technologies']);
    if (!allowedTables.has(tableName)) throw new Error(`Unsupported lookup table: ${tableName}`);

    const result = await client.query(
        `
        INSERT INTO ${tableName} (name)
        VALUES ($1)
        ON CONFLICT ((LOWER(name)))
        DO UPDATE SET name = EXCLUDED.name
        RETURNING id;
        `,
        [value]
    );

    return result.rows[0].id;
}

async function replaceManyToManyLookup(
    client,
    organizationId,
    values,
    lookupTable,
    junctionTable,
    junctionIdColumn
) {
    await client.query(
        `DELETE FROM ${junctionTable} WHERE organization_id = $1;`,
        [organizationId]
    );

    for (const value of uniqueCaseInsensitive(values)) {
        const lookupId = await upsertLookupValue(client, lookupTable, value);

        await client.query(
            `
            INSERT INTO ${junctionTable} (organization_id, ${junctionIdColumn})
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING;
            `,
            [organizationId, lookupId]
        );
    }
}

async function replaceTaxonomies(client, organizationId, org) {
    await replaceManyToManyLookup(
        client,
        organizationId,
        org.category,
        'categories',
        'organization_categories',
        'category_id'
    );

    await replaceManyToManyLookup(
        client,
        organizationId,
        org.topics,
        'topics',
        'organization_topics',
        'topic_id'
    );

    await replaceManyToManyLookup(
        client,
        organizationId,
        org.technologies,
        'technologies',
        'organization_technologies',
        'technology_id'
    );
}

async function replaceRepositories(client, organizationId, repositories) {
    await client.query(
        'DELETE FROM organization_repositories WHERE organization_id = $1;',
        [organizationId]
    );

    for (const repo of repositories || []) {
        if (!repo?.id || !repo?.name) continue;

        const license = repo.license || {};

        const result = await client.query(
            `
            INSERT INTO repositories (
                github_repo_id,
                github_node_id,
                name,
                full_name,
                html_url,
                description,
                language,
                stars,
                forks,
                open_issues,
                license_key,
                license_name,
                license_spdx_id,
                license_url,
                last_synced_at
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12, $13, $14,
                CURRENT_TIMESTAMP
            )
            ON CONFLICT (github_repo_id)
            DO UPDATE SET
                github_node_id = EXCLUDED.github_node_id,
                name = EXCLUDED.name,
                full_name = EXCLUDED.full_name,
                html_url = EXCLUDED.html_url,
                description = EXCLUDED.description,
                language = EXCLUDED.language,
                stars = EXCLUDED.stars,
                forks = EXCLUDED.forks,
                open_issues = EXCLUDED.open_issues,
                license_key = EXCLUDED.license_key,
                license_name = EXCLUDED.license_name,
                license_spdx_id = EXCLUDED.license_spdx_id,
                license_url = EXCLUDED.license_url,
                last_synced_at = CURRENT_TIMESTAMP
            RETURNING id;
            `,
            [
                repo.id,
                repo.node_id || null,
                repo.name,
                repo.full_name || null,
                repo.html_url || null,
                repo.description || null,
                repo.language || null,
                Number(repo.stargazers_count || 0),
                Number(repo.forks_count || 0),
                Number(repo.open_issues_count || 0),
                license.key || null,
                license.name || null,
                license.spdx_id || null,
                license.url || null
            ]
        );

        const repositoryId = result.rows[0].id;

        await client.query(
            `
            INSERT INTO organization_repositories (organization_id, repository_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING;
            `,
            [organizationId, repositoryId]
        );

        await client.query(
            'DELETE FROM repository_topics WHERE repository_id = $1;',
            [repositoryId]
        );

        for (const topic of uniqueCaseInsensitive(repo.topics)) {
            await client.query(
                `
                INSERT INTO repository_topics (repository_id, topic)
                VALUES ($1, $2)
                ON CONFLICT DO NOTHING;
                `,
                [repositoryId, topic]
            );
        }
    }
}

async function replaceContributors(client, organizationId, contributors) {
    await client.query(
        'DELETE FROM organization_contributors WHERE organization_id = $1;',
        [organizationId]
    );

    for (const contributor of contributors || []) {
        if (!contributor?.id || !contributor?.login) continue;

        const result = await client.query(
            `
            INSERT INTO contributors (
                github_user_id,
                github_node_id,
                login,
                avatar_url,
                html_url
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (github_user_id)
            DO UPDATE SET
                github_node_id = EXCLUDED.github_node_id,
                login = EXCLUDED.login,
                avatar_url = EXCLUDED.avatar_url,
                html_url = EXCLUDED.html_url
            RETURNING id;
            `,
            [
                contributor.id,
                contributor.node_id || null,
                contributor.login,
                contributor.avatar_url || null,
                contributor.html_url || null
            ]
        );

        await client.query(
            `
            INSERT INTO organization_contributors (
                organization_id,
                contributor_id,
                contributions
            )
            VALUES ($1, $2, $3)
            ON CONFLICT (organization_id, contributor_id)
            DO UPDATE SET contributions = EXCLUDED.contributions;
            `,
            [
                organizationId,
                result.rows[0].id,
                Number(contributor.contributions || 0)
            ]
        );
    }
}

async function insertGithubStats(client, organizationId, totalCommits) {
    await client.query(
        `
        INSERT INTO organization_github_stats (
            organization_id,
            commit_count
        )
        VALUES ($1, $2);
        `,
        [organizationId, Number(totalCommits || 0)]
    );
}

async function persistOrganization(client, org) {
    console.log(`[${org.name}] Starting organization upsert`);
    const organizationId = await upsertOrganization(client, org);
    console.log(`[${org.name}] Organization upserted: ${organizationId}`);

    console.log(`[${org.name}] Adding contacts`);
    await replaceOrganizationContacts(client, organizationId, org);

    console.log(`[${org.name}] Adding years and projects`);
    await replaceOrganizationYearsAndProjects(client, organizationId, org);

    console.log(`[${org.name}] Adding taxonomies`);
    await replaceTaxonomies(client, organizationId, org);

    console.log(`[${org.name}] Adding repositories`);
    await replaceRepositories(
        client,
        organizationId,
        org.repositories || []
    );

    console.log(`[${org.name}] Adding contributors`);
    await replaceContributors(
        client,
        organizationId,
        org.contributorsDetails || []
    );

    console.log(`[${org.name}] Adding GitHub stats`);
    await insertGithubStats(
        client,
        organizationId,
        org.totalCommits || 0
    );

    console.log(`[${org.name}] Organization persistence completed`);

    return organizationId;
}

// -----------------------------------------------------------------------------
// CHANGED: each organization is now persisted in its OWN transaction instead
// of all 530 orgs sharing a single BEGIN/COMMIT. This keeps individual
// transactions short (lighter on Neon's free-tier compute/connection limits)
// and means a failure on one org no longer rolls back every org that already
// succeeded. The one connection (`client`) is still reused for the whole run
// to avoid 530 separate connect/disconnect round trips.
// -----------------------------------------------------------------------------
async function persistAllOrganizations(organizations) {
    const client = await pool.connect();
    let processed = 0;
    const failures = [];

    try {
        for (const org of organizations) {
            try {
                await client.query('BEGIN');

                console.log(
                    `\n[DB START ${processed + 1}/${organizations.length}] Adding organization: ${org.name}`
                );

                console.log('GitHub ID:', org.githubID);
                console.log('Repositories:', org.repositories?.length || 0);
                console.log('Contributors:', org.contributorsDetails?.length || 0);
                console.log('Years:', org.year?.length || 0);

                await persistOrganization(client, org);

                await client.query('COMMIT');
                processed++;

                console.log(
                    `[DB DONE ${processed}/${organizations.length}] Successfully added: ${org.name}`
                );
            } catch (error) {
                await client.query('ROLLBACK');
                console.error(`[DB FAILED] ${org.name}: ${error.message}`);
                failures.push({ name: org.name, error: error.message });
                // Continue with the next org instead of aborting the whole run.
            }
        }

        // Remove global GitHub records no longer linked to any organization.
        // This keeps repeat refreshes from leaving stale orphan rows.
        // Runs in its own small transaction, once, after all orgs are done.
        await client.query('BEGIN');

        await client.query(`
            DELETE FROM repositories r
            WHERE NOT EXISTS (
                SELECT 1
                FROM organization_repositories orr
                WHERE orr.repository_id = r.id
            );
        `);

        await client.query(`
            DELETE FROM contributors c
            WHERE NOT EXISTS (
                SELECT 1
                FROM organization_contributors oc
                WHERE oc.contributor_id = c.id
            );
        `);

        await client.query('COMMIT');
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // ignore rollback errors here; original error is what matters
        }
        throw error;
    } finally {
        client.release();
    }

    return { processed, failures };
}

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

async function compileData() {
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

        for (let i = 0; i < organizations.length; i++) {
            const org = organizations[i];
            console.log(`\n[${i + 1}/${organizations.length}] Enriching ${org.name}`);
            enrichedOrganizations.push(
                await enrichOrganizationWithGithub(org, caches, runtimeGithubCache)
            );
        }

        canonicalOrganizations = canonicalizeOrganizations(enrichedOrganizations);

        console.log(
            `Canonical identity merge: ${enrichedOrganizations.length} -> ${canonicalOrganizations.length} organizations.`
        );

        // CHANGED: persistAllOrganizations now commits per-organization and
        // returns how many succeeded plus any per-org failures, instead of
        // an all-or-nothing single transaction.
        const { processed, failures } = await persistAllOrganizations(canonicalOrganizations);

        if (failures.length > 0) {
            console.warn(`\n${failures.length} organization(s) failed to persist:`);
            for (const failure of failures) {
                console.warn(`  - ${failure.name}: ${failure.error}`);
            }
        }

        await writeLegacyOutputs(
            canonicalOrganizations,
            gsocYears,
            {
                categories: [...compiledOrgsData.totalCategories],
                topics: [...compiledOrgsData.totalTopics],
                technologies: [...compiledOrgsData.totalTechnologies]
            },
            caches
        );

        await finishSyncRun(
            syncRunId,
            'SUCCESS',
            processed,
            failures.length > 0 ? JSON.stringify(failures).slice(0, 10000) : null
        );

        console.log('\n========================================');
        console.log('GSoC Hub refresh completed successfully.');
        console.log(`Years: ${gsocYears[0]}-${gsocYears[gsocYears.length - 1]}`);
        console.log(`Organizations processed: ${processed}/${canonicalOrganizations.length}`);
        if (failures.length > 0) {
            console.log(`Organizations failed: ${failures.length}`);
        }
        console.log('========================================');
    } catch (error) {
        console.error('\nGSoC Hub refresh failed:');
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

await compileData();
