# Country database

`dbip-country-lite-*.mmdb` is DB-IP's free "IP to Country Lite" database, the
monthly MMDB edition. Only the ISO country of a connection address is read from
it; no address is stored.

- **Source:** https://download.db-ip.com/free/ (monthly file)
- **Licence:** CC BY 4.0 — attribution "IP geolocation by DB-IP" is required
  wherever the derived countries are shown.
- **Refresh:** `bun --no-env-file run scripts/update-geo-db.ts` downloads the
  newest month, verifies it opens and resolves a known address, and only then
  replaces the file here. Run it by hand, monthly.

The server reads the newest file by name at startup. Removing the file disables
country capture with one warning; nothing else changes.
