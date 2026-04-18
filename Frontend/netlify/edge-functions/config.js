// netlify/edge-functions/config.js
// Runs on Netlify's edge — reads env vars and returns them as JSON.
// The browser frontend fetches /config at startup.

export default () => {
    const config = {
        googleClientId: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
        driveFolderIds: {
            "Cotton":             Deno.env.get("DRIVE_FOLDER_COTTON")          ?? "",
            "Polyester":          Deno.env.get("DRIVE_FOLDER_POLYESTER")       ?? "",
            "Denim":              Deno.env.get("DRIVE_FOLDER_DENIM")           ?? "",
            "Wool":               Deno.env.get("DRIVE_FOLDER_WOOL")            ?? "",
            "Silk":               Deno.env.get("DRIVE_FOLDER_SILK")            ?? "",
            "Nylon":              Deno.env.get("DRIVE_FOLDER_NYLON")           ?? "",
            "Acrylic":            Deno.env.get("DRIVE_FOLDER_ACRYLIC")         ?? "",
            "Mixed (Cotton+)":    Deno.env.get("DRIVE_FOLDER_MIXED_COTTON")    ?? "",
            "Mixed (Polyester+)": Deno.env.get("DRIVE_FOLDER_MIXED_POLYESTER") ?? "",
        },
    };

    return Response.json(config, {
        headers: { "Cache-Control": "no-store" },
    });
};
