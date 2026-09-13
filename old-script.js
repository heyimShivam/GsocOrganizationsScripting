import fs from "fs";

const gsocYears = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();;

const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
};

function gsocJsonFilePath(year) {
    return "./GSoC/" + year + ".json";
}

class organizationData {
    parentOrganizationsData = {};
    idAndURLHashMap = {};
    totalcategories = new Set();
    totalTopics = new Set();
    totalTechnologies = new Set();

    _getIdFromOrgName(name, url, description) {
        const idName = name.toLowerCase().replace(/[^a-zA-Z\d ]/g, '').split(' ').join('');
        const idDescription = description.toLowerCase().replace(/[^a-zA-Z\d ]/g, '').split(' ').join('');
        let idURL = url.match(/https?:\/\/(?:www\.)?([^\/]+)/i)[1].toLowerCase();

        if (idURL && this.idAndURLHashMap[idURL])
            return this.idAndURLHashMap[idURL];
        else if (this.idAndURLHashMap[idName])
            return this.idAndURLHashMap[idName];
        else if (this.idAndURLHashMap[idDescription])
            return this.idAndURLHashMap[idDescription];

        this.idAndURLHashMap[idName] = idName;
        this.idAndURLHashMap[idDescription] = idName;
        if (idURL && idURL !== "github.com" && idURL !== "docs.google.com" && idURL !== "summerofcode.withgoogle.com")
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

        if (Array.isArray(obj.category) && obj.category) {
            this.parentOrganizationsData[id].category = [...new Set(
                [...this.parentOrganizationsData[id].category, ...obj.category])];
        } else if (obj.category) {
            this.parentOrganizationsData[id].category = [...new Set(
                [...this.parentOrganizationsData[id].category, ...[obj.category]])];
        }

        this.parentOrganizationsData[id].topics = [...new Set(
            [...this.parentOrganizationsData[id].topics, ...obj.topics])];

        this.parentOrganizationsData[id].technologies = [...new Set(
            [...this.parentOrganizationsData[id].technologies, ...obj.technologies])];

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
            [...this.parentOrganizationsData[id].year, ...[year]])];

        this.parentOrganizationsData[id].projects[[year]] = obj.projects;
    }

    add(obj, year) {
        const id = this._getIdFromOrgName(obj.name, obj.url, obj.description);

        if (Array.isArray(obj.category))
            this.totalcategories = [...new Set(
                [...this.totalcategories, ...obj.category])];
        else {
            this.totalcategories.add(obj.category);
        }

        if (Array.isArray(obj.topics))
            this.totalTopics = [...new Set(
                [...this.totalTopics, ...obj.topics])];
        else {
            this.totalTopics.add(obj.topics);
        }

        if (Array.isArray(obj.topics))
            this.totalTechnologies = [...new Set(
                [...this.totalTechnologies, ...obj.technologies])];
        else {
            this.totalTechnologies.add(obj.technologies);
        }

        if (this.parentOrganizationsData[id]) {
            this._mergeChanges(id, obj, year);
        } else {
            this.parentOrganizationsData[id] = {
                name: obj.name,
                image_url: obj.image_url,
                image_background_color: obj.image_background_color,
                description: obj.description,
                url: obj.url,
                category: Array.isArray(obj.category) ? [...obj.category] : [obj.category],
                topics: Array.isArray(obj.topics) ? [...obj.topics] : [obj.topics],
                technologies: Array.isArray(obj.technologies) ? [...obj.technologies] : [obj.technologies],
                irc_channel: obj.irc_channel,
                contact_email: obj.contact_email,
                mailing_list: obj.mailing_list,
                twitter_url: obj.twitter_url,
                blog_url: obj.blog_url,
                facebook_url: obj.facebook_url,
                year: [year],
                projects: { [year]: [...obj.projects] }
            }
        }
    }


}

function fetchOrganizationsData(compiledOrgsData) {
    for (const year of gsocYears) {
        const data = JSON.parse(fs.readFileSync(gsocJsonFilePath(year)));

        for (const orgObj of data.organizations) {
            compiledOrgsData.add(orgObj, year);
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

const alreadyPresentGithubIDs = JSON.parse(fs.readFileSync("./github-id-and-orgnames-backup.json"));

async function findOrganizationIDWithNameGiven(orgName) {
    const url = new URL('https://api.github.com/search/users');
    url.searchParams.append('q', `${orgName} type:org`);
    url.searchParams.append('per_page', '1');


    if (alreadyPresentGithubIDs[orgName] && alreadyPresentGithubIDs[orgName] !== "")
        return alreadyPresentGithubIDs[orgName];

    try {
        const response = await fetch(url, { headers });
        // const remaining = response.headers.get('x-ratelimit-remaining');
        // const reset = new Date(response.headers.get('x-ratelimit-reset') * 1000);
        // console.log(`${orgName} - Rate Limit Remaining: ${remaining}, Reset: ${reset}`);

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.json();

        if (data.total_count > 0) {
            console.log(`Fetched: ${orgName}`);
            return data.items[0].login;
        } else {
            console.log(`No GitHub organization found for: ${orgName}`);
            return "NA";
        }
    } catch (error) {
        console.error(`Error fetching GitHub ID for ${orgName}: ${error.message}`);
        return "";
    }
}

const alreadyPresentOrgReposIDs = JSON.parse(fs.readFileSync("./github-id-and-repos-backup.json"));

async function fetchOrgRepos(githubID) {
    if (githubID === "NA") return [];

    if (alreadyPresentOrgReposIDs[githubID] && alreadyPresentOrgReposIDs[githubID].length > 0)
        return alreadyPresentOrgReposIDs[githubID];

    const url = new URL(`https://api.github.com/orgs/${githubID}/repos?sort=pushed`);

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
            return data;
        } else {
            console.log(`No Repo found for: ${githubID}`);
            return [];
        }
    } catch (error) {
        console.error(`Error fetching Repo for ${githubID}: ${error.message}`);
        return [];
    }
}


async function fetchCalculateOrgActivity(githubID, repoName) {
    // Data has been collected based on top 3 org Repos Deatils.

    // Api return Returns the total commit counts for the owner and 
    // total commit counts in all. all is everyone combined, including 
    // the owner in the last 52 weeks. If you'd like to get the commit 
    // counts for non-owners, you can subtract owner from all.
    const url = new URL(`https://api.github.com/repos/${githubID}/${repoName}/stats/participation`);

    try {
        const response = await fetch(url, { headers });
        const remaining = response.headers.get('x-ratelimit-remaining');
        const reset = new Date(response.headers.get('x-ratelimit-reset') * 1000);
        console.log(`${githubID} - Rate Limit Remaining: ${remaining}, Reset: ${reset}`);

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.json();
        const commits = data?.all?.reduce((result, item) => {
            return result + Number(item);
        }, 0);

        return commits;
    } catch (error) {
        console.error(`Error fetching Repo for ${githubID}: ${error.message}`);
        return 0;
    }
}

async function fetchContributorsDeatils(githubID, repoName) {
    // Data has been collected based on top 3 org Repos Deatils.

    // Api return Returns the total commit counts for the owner and 
    // total commit counts in all. all is everyone combined, including 
    // the owner in the last 52 weeks. If you'd like to get the commit 
    // counts for non-owners, you can subtract owner from all.
    const url = new URL(`https://api.github.com/repos/${githubID}/${repoName}/contributors`);

    try {
        const response = await fetch(url, { headers });
        const remaining = response.headers.get('x-ratelimit-remaining');
        const reset = new Date(response.headers.get('x-ratelimit-reset') * 1000);
        console.log(`${githubID} - Rate Limit Remaining: ${remaining}, Reset: ${reset}`);

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.json();

        return data;
    } catch (error) {
        console.error(`Error fetching Repo for ${githubID}: ${error.message}`);
        return [];
    }
}

async function compileData() {
    let compiledOrgsData = new organizationData();

    fetchOrganizationsData(compiledOrgsData);
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

        if (githubID !== "NA") {
            let reposDetails = await fetchOrgRepos(githubID);
            githubIDAndReposHashMap[githubID] = reposDetails;
            resultedOrgsArray[i].repositories = reposDetails;

            let contributorsDeatilsArray = [];

            const backupCommitCountMap = JSON.parse(fs.readFileSync("./github-id-and-commits-count-hashmap.json"));
            const backupContributorsMap = JSON.parse(fs.readFileSync("./github-id-and-contributors.json"));
            // const backupCommitCountMap = {};
            // const backupContributorsMap = {};

            for (let i = 0; i < reposDetails.length && i < 3; i++) {
                if (backupCommitCountMap[githubID]) {
                    totalCommits = backupCommitCountMap[githubID];
                } else {
                    const repocommit = await fetchCalculateOrgActivity(githubID, reposDetails[i].name);
                    totalCommits += repocommit;
                }

                if (i < 2) {
                    if (backupContributorsMap[githubID]) {
                        contributorsDeatilsArray = backupContributorsMap[githubID];
                    } else {
                        let deatils = await fetchContributorsDeatils(githubID, reposDetails[i].name);
                        contributorsDeatilsArray = [...contributorsDeatilsArray, ...deatils];
                    }
                }
            }


            githubIDAndCommitCount[githubID] = totalCommits;
            githubIDAndContributorsHashMap[githubID] = contributorsDeatilsArray;
            resultedOrgsArray[i].contributorsDeatils = contributorsDeatilsArray;
            if (totalCommits >= 52 * 7) resultedOrgsArray[i].activeOrg = true;
            else resultedOrgsArray[i].activeOrg = false;
        }

        function cleanString(str) {
            return str.replace(/[^a-zA-Z0-9 ]/g, '');
        }

        tempData = {
            name: resultedOrgsArray[i].name,
            image_url: resultedOrgsArray[i].image_url,
            image_background_color: resultedOrgsArray[i].image_background_color,
            description: resultedOrgsArray[i].description,
            url: resultedOrgsArray[i].url,
            category: Array.isArray(resultedOrgsArray[i].category) ? [...resultedOrgsArray[i].category] : [resultedOrgsArray[i].category],
            topics: resultedOrgsArray[i].topics,
            technologies: resultedOrgsArray[i].technologies,
            year: resultedOrgsArray[i].year,
            githubID: resultedOrgsArray[i].githubID,
            activeOrg: resultedOrgsArray[i].activeOrg
        }

        result.push(tempData);

        try {
            let testMe = JSON.stringify(resultedOrgsArray[i]);
            await fs.writeFile(`.././src/data/OrganizationsDetails(GSoC)/${cleanString(resultedOrgsArray[i].name)} ${cleanString(resultedOrgsArray[i].githubID)}.json`, testMe, 'utf8', (err) => {
                if (err) {
                    console.error('Error writing file', err);
                }
            });
        } catch (error) {
            console.error(`Error writing file for ${resultedOrgsArray[i].name}: ${error.message}`);
        }
    }

    const finalData = JSON.stringify({
        orgData: result,
        totalGsocYears: gsocYears,
        totalcategories: [...compiledOrgsData.totalcategories],
        totalTopics: [...compiledOrgsData.totalTopics],
        totalTechnologies: [...compiledOrgsData.totalTechnologies],
    }, null, 2);

    fs.writeFile('./github-id-and-commits-count-hashmap.json', JSON.stringify(githubIDAndCommitCount), 'utf8', (err) => {
        if (err) {
            console.error('Error writing file', err);
        } else {
            console.log('JSON file has been saved githubIDAndCommitCount.');
        }
    });

    fs.writeFile('./github-id-and-contributors.json', JSON.stringify(githubIDAndContributorsHashMap), 'utf8', (err) => {
        if (err) {
            console.error('Error writing file', err);
        } else {
            console.log('JSON file has been saved githubIDAndContributorsHashMap.');
        }
    });

    fs.writeFile('./github-id-and-repos.json', JSON.stringify(githubIDAndReposHashMap), 'utf8', (err) => {
        if (err) {
            console.error('Error writing file', err);
        } else {
            console.log('JSON file has been saved githubIDAndReposHashMap.');
        }
    });

    fs.writeFile('./github-id-and-orgnames.json', JSON.stringify(orgNameAndIdHashMap), 'utf8', (err) => {
        if (err) {
            console.error('Error writing file', err);
        } else {
            console.log('JSON file has been saved orgNameAndIdHashMap.');
        }
    });

    fs.writeFile('.././src/data/CompiledData/organizations.json', finalData, 'utf8', (err) => {
        if (err) {
            console.error('Error writing file', err);
        } else {
            console.log('JSON file has been saved.');
            console.log('Total orgs complied are ' + resultedOrgsArray.length + '.')
        }
    });
}

compileData();