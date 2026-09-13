import { create } from 'xmlbuilder2';
import fs from 'fs/promises'; // Use promise-based fs

const date = '2025-05-20';
const frequency = 'monthly';
const priorityOrgDetails = '0.6';

const urls = [
    {
        loc: 'https://www.gsochub.com/',
        priority: '1.0',
        changefreq: 'yearly',
        lastmod: date
    },
    {
        loc: 'https://www.gsochub.com/organization/',
        priority: '0.9',
        changefreq: 'monthly',
        lastmod: date
    }
];

const doc = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('urlset', { xmlns: 'http://www.sitemaps.org/schemas/sitemap/0.9' });

urls.forEach(({ loc, priority, changefreq, lastmod }) => {
    doc.ele('url')
        .ele('loc').txt(loc).up()
        .ele('priority').txt(priority).up()
        .ele('changefreq').txt(changefreq).up()
        .ele('lastmod').txt(lastmod).up()
        .up();
});

async function generateSitemap() {
    const orgNameAndGithubIDHashMap = JSON.parse(await fs.readFile('./github-id-and-orgnames.json', 'utf8'));

    for (const orgName in orgNameAndGithubIDHashMap) {
        const githubId = orgNameAndGithubIDHashMap[orgName];
        doc.ele('url')
            .ele('loc').txt(`https://www.gsochub.com/organization/${encodeURIComponent(orgName)}/${encodeURIComponent(githubId)}`).up()
            .ele('priority').txt(priorityOrgDetails).up()
            .ele('changefreq').txt(frequency).up()
            .ele('lastmod').txt(date).up()
            .up();
    }

    const xml = doc.end({ prettyPrint: true });
    await fs.writeFile('../organization-selection-tool/public/sitemap.xml', xml);
    console.log('✅ sitemap.xml generated successfully.');
}

generateSitemap();
