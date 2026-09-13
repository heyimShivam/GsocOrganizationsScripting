import fs from 'fs/promises';
import { config } from 'dotenv';
import Bottleneck from 'bottleneck';

// Load environment variables
config();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();;

const gsocYears = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const useOldRecords = false;

const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
};

// Rate limiter to avoid hitting GitHub API limits
const limiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 2000 // 2 seconds between requests
});

function gsocJsonFilePath(year) {
    return `./GSoC/${year}.json`;
}

class OrganizationData {
    parentOrganizationsData = {};
    idAndURLHashMap = {};
    totalCategories = new Set();
    totalTopics = new Set();
    totalTechnologies = new Set();

    _getIdFromOrgName(name, url, description) {
        const idName = name.toLowerCase().replace(/[^a-zA-Z\d ]/g, '').split(' ').join('');
        const idDescription = description.toLowerCase().replace(/[^a-zA-Z\d ]/g, '').split(' ').join('');
        let idURL = url.match(/https?:\/\/(?:www\.)?([^\/]+)/i)?.[1]?.toLowerCase();

        if (idURL && this.idAndURLHashMap[idURL])
            return this.idAndURLHashMap[idURL];
        else if (this.idAndURLHashMap[idName])
            return this.idAndURLHashMap[idName];
        else if (this.idAndURLHashMap[idDescription])
            return this.idAndURLHashMap[idDescription];

        this.idAndURLHashMap[idName] = idName;
        this.idAndURLHashMap[idDescription] = idName;
        if (idURL && idURL !== 'github.com' && idURL !== 'docs.google.com' && idURL !== 'summerofcode.withgoogle.com')
            this.idAndURLHashMap[idURL] = idName;

        return idName;
    }

    _mergeChanges(id, obj, year) {
        if (obj.image_url) {
            this.parentOrganizationsData[id].image_url = obj.image_url;
        }

        if (obj.image_background_color) {
            this.parentOrganizationsData[id].image_background_color = obj.image_background_color;
        }

        if (obj.description) {
            this.parentOrganizationsData[id].description = obj.description;
        }

        if (obj.name) {
            this.parentOrganizationsData[id].name = obj.name;
        }

        if (obj.url) {
            this.parentOrganizationsData[id].url = obj.url;
        }

        if (obj.category) {
            const categories = Array.isArray(obj.category) ? obj.category : [obj.category];
            this.parentOrganizationsData[id].category = [...new Set(
                [...this.parentOrganizationsData[id].category, ...categories])];
        }

        this.parentOrganizationsData[id].topics = [...new Set(
            [...this.parentOrganizationsData[id].topics, ...(Array.isArray(obj.topics) ? obj.topics : [obj.topics])])];

        this.parentOrganizationsData[id].technologies = [...new Set(
            [...this.parentOrganizationsData[id].technologies, ...(Array.isArray(obj.technologies) ? obj.technologies : [obj.technologies])])];

        if (obj.irc_channel) {
            this.parentOrganizationsData[id].irc_channel = obj.irc_channel;
        }

        if (obj.contact_email)
            this.parentOrganizationsData[id].contact_email = obj.contact_email;

        if (obj.mailing_list)
            this.parentOrganizationsData[id].mailing_list = obj.mailing_list;

        if (obj.twitter_url)
            this.parentOrganizationsData[id].twitter_url = obj.twitter_url;

        if (obj.blog_url)
            this.parentOrganizationsData[id].blog_url = obj.blog_url;

        if (obj.facebook_url)
            this.parentOrganizationsData[id].facebook_url = obj.facebook_url;

        this.parentOrganizationsData[id].year = [...new Set(
            [...this.parentOrganizationsData[id].year, year])];

        this.parentOrganizationsData[id].projects[year] = obj.projects;
    }

    add(obj, year) {
        const id = this._getIdFromOrgName(obj.name, obj.url, obj.description);

        if (obj.category) {
            const categories = Array.isArray(obj.category) ? obj.category : [obj.category];
            this.totalCategories = new Set([...this.totalCategories, ...categories]);
        }

        if (obj.topics) {
            const topics = Array.isArray(obj.topics) ? obj.topics : [obj.topics];
            this.totalTopics = new Set([...this.totalTopics, ...topics]);
        }

        if (obj.technologies) {
            const technologies = Array.isArray(obj.technologies) ? obj.technologies : [obj.technologies];
            this.totalTechnologies = new Set([...this.totalTechnologies, ...technologies]);
        }

        if (this.parentOrganizationsData[id]) {
            this._mergeChanges(id, obj, year);
        } else {
            this.parentOrganizationsData[id] = {
                name: obj.name,
                image_url: obj.image_url || null,
                image_background_color: obj.image_background_color || null,
                description: obj.description || null,
                url: obj.url || null,
                category: Array.isArray(obj.category) ? [...obj.category] : [obj.category].filter(Boolean),
                topics: Array.isArray(obj.topics) ? [...obj.topics] : [obj.topics].filter(Boolean),
                technologies: Array.isArray(obj.technologies) ? [...obj.technologies] : [obj.technologies].filter(Boolean),
                irc_channel: obj.irc_channel || null,
                contact_email: obj.contact_email || null,
                mailing_list: obj.mailing_list || null,
                twitter_url: obj.twitter_url || null,
                blog_url: obj.blog_url || null,
                facebook_url: obj.facebook_url || null,
                year: [year],
                projects: { [year]: [...obj.projects] }
            };
        }
    }
}

async function fetchOrganizationsData(compiledOrgsData) {
    for (const year of gsocYears) {
        try {
            const data = JSON.parse(await fs.readFile(gsocJsonFilePath(year), 'utf8'));
            for (const orgObj of data.organizations) {
                compiledOrgsData.add(orgObj, year);
            }
        } catch (error) {
            console.error(`Error reading file for year ${year}: ${error.message}`);
        }
    }
}

const objectSorter = (GFG_Object) =>
    Object.keys(GFG_Object)
        .sort()
        .reduce((finalObject, key) => {
            finalObject[key] = GFG_Object[key];
            return finalObject;
        }, {});

async function findOrganizationIDWithNameGiven(orgName) {
    const alreadyPresentGithubIDs = JSON.parse(await fs.readFile('./github-id-and-orgnames.json', 'utf8'));
    if (alreadyPresentGithubIDs[orgName] && alreadyPresentGithubIDs[orgName] !== '')
        return alreadyPresentGithubIDs[orgName];

    const url = new URL('https://api.github.com/search/users');
    url.searchParams.append('q', `${orgName} type:org`);
    url.searchParams.append('per_page', '1');

    return limiter.schedule(async () => {
        try {
            const response = await fetch(url, { headers });
            const remaining = response.headers.get('x-ratelimit-remaining');
            const reset = new Date(response.headers.get('x-ratelimit-reset') * 1000);
            console.log(`${orgName} - Rate Limit Remaining: ${remaining}, Reset: ${reset}`);

            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            const data = await response.json();

            if (data.total_count > 0) {
                console.log(`Fetched: ${orgName}`);
                return data.items[0].login;
            } else {
                console.log(`No GitHub organization found for: ${orgName}`);
                return 'NA';
            }
        } catch (error) {
            console.error(`Error fetching GitHub ID for ${orgName}: ${error.message}`);
            return '';
        }
    });
}

async function fetchOrgRepos(githubID) {
    if (githubID === 'NA') return [];

    if (useOldRecords) {
        const alreadyPresentOrgReposIDs = JSON.parse(await fs.readFile('./github-id-and-repos.json', 'utf8'));
        if (alreadyPresentOrgReposIDs[githubID] && alreadyPresentOrgReposIDs[githubID].length > 0)
            return alreadyPresentOrgReposIDs[githubID];
    }

    const url = new URL(`https://api.github.com/orgs/${githubID}/repos?sort=pushed`);

    return limiter.schedule(async () => {
        try {
            const response = await fetch(url, { headers });
            const remaining = response.headers.get('x-ratelimit-remaining');
            const reset = new Date(response.headers.get('x-ratelimit-reset') * 1000);
            console.log(`${githubID} - Rate Limit Remaining: ${remaining}, Reset: ${reset}`);

            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            const data = await response.json();

            if (data.length > 0) {
                console.log(`Fetched: ${githubID}`);
                return data.map(repo => ({
                    id: repo.id,
                    node_id: repo.node_id,
                    name: repo.name,
                    full_name: repo.full_name,
                    html_url: repo.html_url,
                    description: repo.description,
                    language: repo.language,
                    stargazers_count: repo.stargazers_count,
                    forks_count: repo.forks_count,
                    open_issues_count: repo.open_issues_count,
                    license: repo.license,
                    topics: repo.topics
                }));
            } else {
                console.log(`No Repo found for: ${githubID}`);
                return [];
            }
        } catch (error) {
            console.error(`Error fetching Repo for ${githubID}: ${error.message}`);
            return [];
        }
    });
}

async function fetchCalculateOrgActivity(githubID, repoName) {
    const url = new URL(`https://api.github.com/repos/${githubID}/${repoName}/stats/participation`);

    return limiter.schedule(async () => {
        try {
            const response = await fetch(url, { headers });
            const remaining = response.headers.get('x-ratelimit-remaining');
            const reset = new Date(response.headers.get('x-ratelimit-reset') * 1000);
            console.log(`${githubID} - Rate Limit Remaining: ${remaining}, Reset: ${reset}`);

            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            const data = await response.json();
            const commits = data?.all?.reduce((result, item) => result + Number(item), 0) || 0;
            return commits;
        } catch (error) {
            console.error(`Error fetching Repo for ${githubID}: ${error.message}`);
            return 0;
        }
    });
}

async function fetchContributorsDetails(githubID, repoName) {
    const url = new URL(`https://api.github.com/repos/${githubID}/${repoName}/contributors`);

    return limiter.schedule(async () => {
        try {
            const response = await fetch(url, { headers });
            const remaining = response.headers.get('x-ratelimit-remaining');
            const reset = new Date(response.headers.get('x-ratelimit-reset') * 1000);
            console.log(`${githubID} - Rate Limit Remaining: ${remaining}, Reset: ${reset}`);

            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            const data = await response.json();
            return data.map(contributor => ({
                login: contributor.login,
                id: contributor.id,
                node_id: contributor.node_id,
                avatar_url: contributor.avatar_url,
                html_url: contributor.html_url,
                contributions: contributor.contributions
            }));
        } catch (error) {
            console.error(`Error fetching Repo for ${githubID}: ${error.message}`);
            return [];
        }
    });
}

async function compileData() {
    let compiledOrgsData = new OrganizationData();

    await fetchOrganizationsData(compiledOrgsData);
    let sortedCompiledOrgsData = objectSorter(compiledOrgsData.parentOrganizationsData);
    let resultedOrgsArray = [];
    let result = [];

    Object.keys(sortedCompiledOrgsData).forEach(key => {
        const value = sortedCompiledOrgsData[key];
        resultedOrgsArray.push(value);
    });

    let orgNameAndIdHashMap = {};
    let githubIDAndReposHashMap = {};
    let githubIDAndContributorsHashMap = {};
    let githubIDAndCommitCount = {};

    for (let i = 0; i < resultedOrgsArray.length; i++) {
        let tempData = {};
        let githubID = await findOrganizationIDWithNameGiven(resultedOrgsArray[i].name);
        orgNameAndIdHashMap[resultedOrgsArray[i].name] = githubID;
        resultedOrgsArray[i].githubID = githubID;

        let totalCommits = 0;

        if (githubID !== 'NA') {
            let reposDetails = await fetchOrgRepos(githubID);
            githubIDAndReposHashMap[githubID] = reposDetails;
            resultedOrgsArray[i].repositories = reposDetails;

            let contributorsDetailsArray = [];
            const backupCommitCountMap = JSON.parse(await fs.readFile('./github-id-and-commits-count-hashmap.json', 'utf8'));
            const backupContributorsMap = JSON.parse(await fs.readFile('./github-id-and-contributors.json', 'utf8'));

            for (let j = 0; j < reposDetails.length && j < 3; j++) {
                if (backupCommitCountMap[githubID] && useOldRecords) {
                    totalCommits = backupCommitCountMap[githubID];
                } else {
                    const repoCommit = await fetchCalculateOrgActivity(githubID, reposDetails[j].name);
                    totalCommits += repoCommit;
                }

                if (j < 3) {
                    if (backupContributorsMap[githubID] && useOldRecords) {
                        contributorsDetailsArray = backupContributorsMap[githubID];
                    } else {
                        let details = await fetchContributorsDetails(githubID, reposDetails[j].name);
                        contributorsDetailsArray = [...contributorsDetailsArray, ...details];
                    }
                }
            }

            // Deduplicate contributors by login
            contributorsDetailsArray = Array.from(
                new Map(contributorsDetailsArray.map(item => [item.login, item])).values()
            );

            githubIDAndCommitCount[githubID] = totalCommits;
            githubIDAndContributorsHashMap[githubID] = contributorsDetailsArray;
            resultedOrgsArray[i].contributorsDetails = contributorsDetailsArray;
            resultedOrgsArray[i].activeOrg = totalCommits >= 52 * 7;
        } else {
            resultedOrgsArray[i].activeOrg = false;
            resultedOrgsArray[i].repositories = [];
            resultedOrgsArray[i].contributorsDetails = [];
        }

        function cleanString(str) {
            return str.replace(/[^a-zA-Z0-9 ]/g, '') + `_${githubID || 'NA'}`;
        }

        tempData = {
            name: resultedOrgsArray[i].name,
            image_url: resultedOrgsArray[i].image_url,
            image_background_color: resultedOrgsArray[i].image_background_color,
            description: resultedOrgsArray[i].description,
            url: resultedOrgsArray[i].url,
            category: resultedOrgsArray[i].category,
            topics: resultedOrgsArray[i].topics,
            technologies: resultedOrgsArray[i].technologies,
            year: resultedOrgsArray[i].year,
            githubID: resultedOrgsArray[i].githubID,
            activeOrg: resultedOrgsArray[i].activeOrg
        };

        result.push(tempData);

        try {
            await fs.writeFile(
                `.././organization-selection-tool/src/data/OrganizationsDetails(GSoC)/${cleanString(resultedOrgsArray[i].name)}.json`,
                JSON.stringify(resultedOrgsArray[i], null, 2),
                'utf8'
            );
        } catch (error) {
            console.error(`Error writing file for ${resultedOrgsArray[i].name}: ${error.message}`);
        }
    }

    const finalData = JSON.stringify({
        orgData: result,
        totalGsocYears: gsocYears,
        totalCategories: [...compiledOrgsData.totalCategories],
        totalTopics: [...compiledOrgsData.totalTopics],
        totalTechnologies: [...compiledOrgsData.totalTechnologies],
    }, null, 2);

    try {
        await fs.writeFile('./github-id-and-commits-count-hashmap.json', JSON.stringify(githubIDAndCommitCount, null, 2), 'utf8');
        await fs.writeFile('./github-id-and-contributors.json', JSON.stringify(githubIDAndContributorsHashMap, null, 2), 'utf8');
        await fs.writeFile('./github-id-and-repos.json', JSON.stringify(githubIDAndReposHashMap, null, 2), 'utf8');
        await fs.writeFile('./github-id-and-orgnames.json', JSON.stringify(orgNameAndIdHashMap, null, 2), 'utf8');
        await fs.writeFile('.././organization-selection-tool/src/data/CompiledData/organizations.json', finalData, 'utf8');
        console.log('JSON files have been saved.');
        console.log(`Total orgs compiled: ${resultedOrgsArray.length}`);
    } catch (error) {
        console.error(`Error writing output files: ${error.message}`);
    }
}

compileData().catch(error => console.error(`Error in compileData: ${error.message}`));