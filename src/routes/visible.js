// The one visibility rule for every public and bidder-facing auction query (site.js, account.js).
// Not a router: required by the route files that need it.
const { visibleSql } = require('../lib/bidding');

/**
 * SQL condition on auctions alias "a": the auction is published and bidder $n may see it
 * (restricted auctions only for their groups and invited bidders). Bind 0 for a visitor.
 *   db.many(`SELECT ... FROM auctions a WHERE ${listedSql(1)}`, [viewerId(req)])
 */
const listedSql = (n) => `(a.status = 'published' AND ${visibleSql(n)})`;

/** Only the group/invitation part of the rule, for a bidder's own history that also shows cancelled auctions. */
const canSeeSql = (n) => visibleSql(n);

/** The id to bind for listedSql(): the signed-in bidder, or 0 for a visitor. */
const viewerId = (req) => (req && req.user ? req.user.id : 0);

module.exports = { listedSql, canSeeSql, viewerId };
