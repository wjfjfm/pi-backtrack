# Companion dependency snapshot

`pi-dynamic-skill-0.0.0.tgz` contains the matching unpublished dynamic-skill implementation (source, compiled JavaScript, declarations, templates and README files). It is generated from the sibling repository based on `35efad1` plus the integration changes in this work. `package-lock.json` pins the archive's integrity.

A checked-in snapshot keeps `npm ci` self-contained: neither a sibling checkout nor a not-yet-published Git commit is required to install backtrack. It does not automatically enable the dynamic-skill extension.

To update the archive from a sibling checkout:

```sh
cd ../pi-dynamic-skill
npm ci
npm test
npm pack --pack-destination ../pi-backtrack/vendor
cd ../pi-backtrack
npm install --ignore-scripts --no-audit --no-fund
npm test
```

When publishing the matching source commits, this dependency can be replaced with an immutable Git revision. Do not replace it with the old `19dacb4` revision, which does not export the context service.
