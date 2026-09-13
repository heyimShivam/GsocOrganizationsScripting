import pool from './db.js';

const org = {
    name: "AboutCode",
    image_url: "https://summerofcode.withgoogle.com/media/org/aboutcode/HGg92nks_400x400.png",
    image_background_color: "#ffffff",
    description: "Scan code for origin, license and vulnerabilities",
    url: "https://aboutcode.org",
    githubID: "aboutcode-org",
    activeOrg: true
};

async function upsertOrganization(org) {

    // Convert "NA" into a real database NULL.
    const githubId =
        org.githubID &&
            org.githubID.trim().toUpperCase() !== "NA"
            ? org.githubID.trim()
            : null;

    let result;

    if (githubId !== null) {

        // Identity rule:
        // same name + same githubID = same organization

        result = await pool.query(
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

            ON CONFLICT (
                (LOWER(name)),
                (LOWER(github_id))
            )
            WHERE github_id IS NOT NULL

            DO UPDATE SET
                image_url = EXCLUDED.image_url,
                image_background_color = EXCLUDED.image_background_color,
                description = EXCLUDED.description,
                url = EXCLUDED.url,
                active_org = EXCLUDED.active_org,
                updated_at = CURRENT_TIMESTAMP

            RETURNING
                id,
                name,
                github_id,
                active_org;
            `,
            [
                org.name,
                org.image_url,
                org.image_background_color,
                org.description,
                org.url,
                githubId,
                org.activeOrg
            ]
        );

    } else {

        // If githubID = "NA":
        // name alone identifies the organization

        result = await pool.query(
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
            VALUES ($1, $2, $3, $4, $5, NULL, $6)

            ON CONFLICT ((LOWER(name)))
            WHERE github_id IS NULL

            DO UPDATE SET
                image_url = EXCLUDED.image_url,
                image_background_color = EXCLUDED.image_background_color,
                description = EXCLUDED.description,
                url = EXCLUDED.url,
                active_org = EXCLUDED.active_org,
                updated_at = CURRENT_TIMESTAMP

            RETURNING
                id,
                name,
                github_id,
                active_org;
            `,
            [
                org.name,
                org.image_url,
                org.image_background_color,
                org.description,
                org.url,
                org.activeOrg
            ]
        );
    }

    return result.rows[0];
}


async function main() {
    try {

        const organization = await upsertOrganization(org);

        console.log("Organization saved:");
        console.log(organization);

    } catch (error) {

        console.error("Import failed:");
        console.error(error);

    } finally {

        await pool.end();
    }
}

main();