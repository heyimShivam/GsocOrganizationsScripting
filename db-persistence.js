import { performance } from 'node:perf_hooks';

const CHUNK_SIZE = 500;

function chunk(array, size = CHUNK_SIZE) {
    const out = [];
    for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
    return out;
}

function cleanText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
}

function uniqueCaseInsensitive(values) {
    const map = new Map();
    for (const value of Array.isArray(values) ? values : []) {
        const text = cleanText(value);
        if (!text) continue;
        const key = text.toLowerCase();
        if (!map.has(key)) map.set(key, text);
    }
    return [...map.values()];
}

function normalizeGithubId(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    if (!normalized || normalized.toUpperCase() === 'NA') return null;
    return normalized;
}

function getProjectsForYear(org, year) {
    if (Array.isArray(org?.projects?.[year])) return org.projects[year];
    if (Array.isArray(org?.projects?.[String(year)])) return org.projects[String(year)];
    return [];
}

async function bulkInsertValues(client, table, columns, rows, casts = {}) {
    if (!rows.length) return 0;

    const chunks = chunk(rows);
    let inserted = 0;

    for (const rowsChunk of chunks) {
        const values = [];
        const placeholders = rowsChunk.map((row, rowIndex) => {
            const params = row.map((value, colIndex) => {
                values.push(value);
                const parameter = `$${values.length}`;
                const cast = casts[colIndex] ? `::${casts[colIndex]}` : '';
                return `${parameter}${cast}`;
            });
            return `(${params.join(', ')})`;
        });

        await client.query(
            `INSERT INTO ${table} (${columns.join(', ')})
             VALUES ${placeholders.join(', ')}`,
            values
        );

        inserted += rowsChunk.length;
    }

    return inserted;
}

async function bulkUpsertLookup(client, tableName, values) {
    const names = uniqueCaseInsensitive(values);
    if (!names.length) return new Map();

    const result = await client.query(
        `INSERT INTO ${tableName} (name)
         SELECT value
         FROM unnest($1::text[]) AS t(value)
         ON CONFLICT ((LOWER(name)))
         DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name`,
        [names]
    );

    const map = new Map();
    for (const row of result.rows) {
        map.set(String(row.name).toLowerCase(), row.id);
    }

    // RETURNING normally contains every input row, but fetch by name defensively
    // if PostgreSQL/version/driver behavior ever leaves one out.
    if (map.size !== names.length) {
        const missing = names.filter(name => !map.has(name.toLowerCase()));
        if (missing.length) {
            const fallback = await client.query(
                `SELECT id, name
                 FROM ${tableName}
                 WHERE LOWER(name) = ANY($1::text[])`,
                [missing.map(name => name.toLowerCase())]
            );
            for (const row of fallback.rows) {
                map.set(String(row.name).toLowerCase(), row.id);
            }
        }
    }

    return map;
}

async function replaceManyToManyLookupBulk(
    client,
    organizationId,
    values,
    lookupTable,
    junctionTable,
    junctionIdColumn
) {
    await client.query(
        `DELETE FROM ${junctionTable} WHERE organization_id = $1`,
        [organizationId]
    );

    const names = uniqueCaseInsensitive(values);
    if (!names.length) return;

    const idsByName = await bulkUpsertLookup(client, lookupTable, names);

    const rows = [];
    for (const name of names) {
        const id = idsByName.get(name.toLowerCase());
        if (id) rows.push([organizationId, id]);
    }

    await bulkInsertValues(
        client,
        junctionTable,
        ['organization_id', junctionIdColumn],
        rows
    );
}

async function replaceTaxonomiesBulk(client, organizationId, org) {
    await replaceManyToManyLookupBulk(
        client, organizationId, org.category, 'categories',
        'organization_categories', 'category_id'
    );

    await replaceManyToManyLookupBulk(
        client, organizationId, org.topics, 'topics',
        'organization_topics', 'topic_id'
    );

    await replaceManyToManyLookupBulk(
        client, organizationId, org.technologies, 'technologies',
        'organization_technologies', 'technology_id'
    );
}

async function upsertOrganization(client, org) {
    const githubId = normalizeGithubId(org.githubID);
    const name = String(org.name ?? '').trim();

    if (!name) {
        throw new Error('Organization name is required.');
    }

    // Organization identity is the normalized GSoC organization name + GitHub ID.
    // GitHub IDs are NOT unique across GSoC organizations (for example, several
    // organizations can legitimately map to the same GitHub organization).
    const byIdentity = await client.query(
        `SELECT id, name, github_id
         FROM organizations
         WHERE LOWER(name) = LOWER($1)
           AND (
               ($2::text IS NULL AND github_id IS NULL)
               OR LOWER(github_id) = LOWER($2::text)
           )
         ORDER BY updated_at DESC
         LIMIT 2`,
        [name, githubId]
    );

    if (byIdentity.rows.length > 1) {
        throw new Error(
            `Ambiguous organization identity for ${name}: ` +
            `multiple database rows share name + github_id.`
        );
    }

    const existing = byIdentity.rows[0] || null;

    if (existing) {
        const result = await client.query(
            `UPDATE organizations
             SET name = $2,
                 image_url = $3,
                 image_background_color = $4,
                 description = $5,
                 url = $6,
                 github_id = $7,
                 active_org = $8,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING id`,
            [
                existing.id,
                name,
                cleanText(org.image_url),
                cleanText(org.image_background_color),
                cleanText(org.description),
                cleanText(org.url),
                githubId,
                Boolean(org.activeOrg)
            ]
        );

        return result.rows[0].id;
    }

    // No exact name + GitHub ID identity exists. Create a new organization,
    // even when another organization already uses the same GitHub ID.
    const result = await client.query(
        `INSERT INTO organizations (
             name,
             image_url,
             image_background_color,
             description,
             url,
             github_id,
             active_org
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [
            name,
            cleanText(org.image_url),
            cleanText(org.image_background_color),
            cleanText(org.description),
            cleanText(org.url),
            githubId,
            Boolean(org.activeOrg)
        ]
    );

    return result.rows[0].id;
}

async function replaceContactsBulk(client, organizationId, org) {
    await client.query(
        `INSERT INTO organization_contacts (
             organization_id, irc_channel, contact_email, mailing_list,
             twitter_url, blog_url, facebook_url
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (organization_id)
         DO UPDATE SET
             irc_channel = EXCLUDED.irc_channel,
             contact_email = EXCLUDED.contact_email,
             mailing_list = EXCLUDED.mailing_list,
             twitter_url = EXCLUDED.twitter_url,
             blog_url = EXCLUDED.blog_url,
             facebook_url = EXCLUDED.facebook_url`,
        [
            organizationId,
            cleanText(org.irc_channel),
            cleanText(org.contact_email),
            cleanText(org.mailing_list),
            cleanText(org.twitter_url),
            cleanText(org.blog_url),
            cleanText(org.facebook_url)
        ]
    );
}

async function replaceYearsAndProjectsBulk(client, organizationId, org) {
    // Projects cascade from organization_years, so this is the authoritative
    // replacement of both years and projects for this organization.
    await client.query(
        `DELETE FROM organization_years WHERE organization_id = $1`,
        [organizationId]
    );

    const years = [...new Set(
        (Array.isArray(org.year) ? org.year : [])
            .map(Number)
            .filter(Number.isInteger)
    )].sort((a, b) => a - b);

    if (!years.length) return;

    await bulkInsertValues(
        client,
        'organization_years',
        ['organization_id', 'year'],
        years.map(year => [organizationId, year])
    );

    const projectRows = [];
    for (const year of years) {
        for (const project of getProjectsForYear(org, year)) {
            if (!project?.title) continue;

            projectRows.push([
                organizationId,
                year,
                String(project.title),
                cleanText(project.short_description),
                cleanText(project.description),
                cleanText(project.student_name),
                cleanText(project.code_url),
                cleanText(project.proposal_id),
                cleanText(project.project_url)
            ]);
        }
    }

    await bulkInsertValues(
        client,
        'gsoc_projects',
        [
            'organization_id', 'year', 'title', 'short_description',
            'description', 'student_name', 'code_url', 'proposal_id', 'project_url'
        ],
        projectRows
    );
}

function repositoryRow(repo) {
    const license = repo.license || {};
    return [
        Number(repo.id),
        cleanText(repo.node_id),
        String(repo.name),
        cleanText(repo.full_name),
        cleanText(repo.html_url),
        cleanText(repo.description),
        cleanText(repo.language),
        Number(repo.stargazers_count || 0),
        Number(repo.forks_count || 0),
        Number(repo.open_issues_count || 0),
        cleanText(license.key),
        cleanText(license.name),
        cleanText(license.spdx_id),
        cleanText(license.url)
    ];
}

async function replaceRepositoriesBulk(client, organizationId, repositories) {
    await client.query(
        `DELETE FROM organization_repositories WHERE organization_id = $1`,
        [organizationId]
    );

    const validRepoMap = new Map();
    for (const repo of (Array.isArray(repositories) ? repositories : [])) {
        if (!repo?.id || !repo?.name) continue;
        validRepoMap.set(String(repo.id), repo);
    }
    const validRepos = [...validRepoMap.values()];

    if (!validRepos.length) return;

    // One bulk upsert for all repositories in this organization.
    for (const rowsChunk of chunk(validRepos.map(repositoryRow))) {
        const values = [];
        const placeholders = rowsChunk.map(row => {
            const params = row.map(value => {
                values.push(value);
                return `$${values.length}`;
            });
            return `(${params.join(', ')}, CURRENT_TIMESTAMP)`;
        });

        await client.query(
            `INSERT INTO repositories (
                 github_repo_id, github_node_id, name, full_name, html_url,
                 description, language, stars, forks, open_issues,
                 license_key, license_name, license_spdx_id, license_url,
                 last_synced_at
             )
             VALUES ${placeholders.join(', ')}
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
                 last_synced_at = CURRENT_TIMESTAMP`,
            values
        );
    }

    const githubRepoIds = validRepos.map(repo => Number(repo.id));

    const repoResult = await client.query(
        `SELECT id, github_repo_id
         FROM repositories
         WHERE github_repo_id = ANY($1::bigint[])`,
        [githubRepoIds]
    );

    const idByGithubId = new Map(
        repoResult.rows.map(row => [String(row.github_repo_id), row.id])
    );

    const relationshipRows = [];
    const repositoryIds = [];

    for (const repo of validRepos) {
        const repositoryId = idByGithubId.get(String(repo.id));
        if (!repositoryId) {
            throw new Error(`Repository ${repo.id} was upserted but could not be resolved.`);
        }

        relationshipRows.push([organizationId, repositoryId]);
        repositoryIds.push(repositoryId);
    }

    await bulkInsertValues(
        client,
        'organization_repositories',
        ['organization_id', 'repository_id'],
        relationshipRows
    );

    // Replace topics for repositories represented by the current authoritative
    // GitHub snapshot. Do not delete the repository itself here.
    await client.query(
        `DELETE FROM repository_topics
         WHERE repository_id = ANY($1::uuid[])`,
        [repositoryIds]
    );

    const topicRows = [];
    for (const repo of validRepos) {
        const repositoryId = idByGithubId.get(String(repo.id));
        for (const topic of uniqueCaseInsensitive(repo.topics)) {
            topicRows.push([repositoryId, topic]);
        }
    }

    await bulkInsertValues(
        client,
        'repository_topics',
        ['repository_id', 'topic'],
        topicRows
    );
}

async function replaceContributorsBulk(client, organizationId, contributors) {
    await client.query(
        `DELETE FROM organization_contributors WHERE organization_id = $1`,
        [organizationId]
    );

    const validContributorMap = new Map();
    for (const contributor of (Array.isArray(contributors) ? contributors : [])) {
        if (!contributor?.id || !contributor?.login) continue;
        validContributorMap.set(String(contributor.id), contributor);
    }
    const valid = [...validContributorMap.values()];

    if (!valid.length) return;

    for (const rowsChunk of chunk(valid.map(contributor => [
        Number(contributor.id),
        cleanText(contributor.node_id),
        String(contributor.login),
        cleanText(contributor.avatar_url),
        cleanText(contributor.html_url)
    ]))) {
        const values = [];
        const placeholders = rowsChunk.map(row => {
            const params = row.map(value => {
                values.push(value);
                return `$${values.length}`;
            });
            return `(${params.join(', ')})`;
        });

        await client.query(
            `INSERT INTO contributors (
                 github_user_id, github_node_id, login, avatar_url, html_url
             )
             VALUES ${placeholders.join(', ')}
             ON CONFLICT (github_user_id)
             DO UPDATE SET
                 github_node_id = EXCLUDED.github_node_id,
                 login = EXCLUDED.login,
                 avatar_url = EXCLUDED.avatar_url,
                 html_url = EXCLUDED.html_url`,
            values
        );
    }

    const githubUserIds = valid.map(contributor => Number(contributor.id));

    const result = await client.query(
        `SELECT id, github_user_id
         FROM contributors
         WHERE github_user_id = ANY($1::bigint[])`,
        [githubUserIds]
    );

    const idByGithubId = new Map(
        result.rows.map(row => [String(row.github_user_id), row.id])
    );

    const relationshipRows = valid.map(contributor => {
        const contributorId = idByGithubId.get(String(contributor.id));
        if (!contributorId) {
            throw new Error(
                `Contributor ${contributor.id} was upserted but could not be resolved.`
            );
        }

        return [
            organizationId,
            contributorId,
            Number(contributor.contributions || 0)
        ];
    });

    await bulkInsertValues(
        client,
        'organization_contributors',
        ['organization_id', 'contributor_id', 'contributions'],
        relationshipRows
    );
}

async function insertGithubStats(client, organizationId, totalCommits) {
    // Historical snapshot: intentionally INSERT, never UPSERT.
    await client.query(
        `INSERT INTO organization_github_stats (
             organization_id, commit_count
         )
         VALUES ($1, $2)`,
        [organizationId, Number(totalCommits || 0)]
    );
}

async function persistOrganization(client, org) {
    const started = performance.now();
    const organizationId = await upsertOrganization(client, org);

    await replaceContactsBulk(client, organizationId, org);
    await replaceYearsAndProjectsBulk(client, organizationId, org);
    await replaceTaxonomiesBulk(client, organizationId, org);
    await replaceRepositoriesBulk(client, organizationId, org.repositories || []);
    await replaceContributorsBulk(
        client,
        organizationId,
        org.contributorsDetails || []
    );
    await insertGithubStats(client, organizationId, org.totalCommits || 0);

    return {
        organizationId,
        durationMs: Math.round(performance.now() - started)
    };
}

async function cleanupOrphans(client) {
    // Must run only after ALL organization batches have completed.
    await client.query(`
        DELETE FROM repositories r
        WHERE NOT EXISTS (
            SELECT 1
            FROM organization_repositories orr
            WHERE orr.repository_id = r.id
        )
    `);

    await client.query(`
        DELETE FROM contributors c
        WHERE NOT EXISTS (
            SELECT 1
            FROM organization_contributors oc
            WHERE oc.contributor_id = c.id
        )
    `);
}

export function createPersistenceService(pool) {
    return {
        async persistBatch(organizations) {
            const client = await pool.connect();
            let processed = 0;
            const failures = [];

            try {
                for (const org of organizations) {
                    const orgStarted = performance.now();

                    try {
                        await client.query('BEGIN');

                        const result = await persistOrganization(client, org);

                        await client.query('COMMIT');
                        processed++;

                        console.log(
                            `[DB DONE ${processed}/${organizations.length}] ` +
                            `${org.name} (${result.durationMs} ms)`
                        );
                    } catch (error) {
                        try {
                            await client.query('ROLLBACK');
                        } catch (rollbackError) {
                            console.error(
                                `[DB ROLLBACK FAILED] ${org.name}: ${rollbackError.message}`
                            );
                        }

                        console.error(
                            `[DB FAILED] ${org.name}: ${error.message}`
                        );

                        failures.push({
                            name: org.name,
                            githubID: org.githubID ?? null,
                            error: error.message
                        });
                    }

                    const totalMs = Math.round(performance.now() - orgStarted);
                    console.log(
                        `[DB TIMING] ${org.name}: ${totalMs} ms`
                    );
                }
            } finally {
                client.release();
            }

            return { processed, failures };
        },

        async cleanupOrphans() {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await cleanupOrphans(client);
                await client.query('COMMIT');
            } catch (error) {
                try {
                    await client.query('ROLLBACK');
                } catch { }
                throw error;
            } finally {
                client.release();
            }
        }
    };
}
