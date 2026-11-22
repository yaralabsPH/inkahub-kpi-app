/**
 * Classified fixture rows for publication tests and the staging runner. Task
 * 14 moved the owner mapping (the REAL Task 11 projector's facts mapped to the
 * five staged arrays, grouped by owner partition) into production
 * (api/_lib/production-reporting-materialize.ts); this fixture re-exports it so
 * every test and runner uses the one mapping.
 */
export { emptyRows, isoOfMicros, ownerKey, ownerOf, rowsByOwner, type Owner } from "../../api/_lib/production-reporting-materialize";
