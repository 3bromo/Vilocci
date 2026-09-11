// ============================================================================
// SPINTO — Vercel serverless entry point
// Vercel routes every request here (see vercel.json). We simply re-export the
// Express app so all existing routes, static assets, SPA fallbacks and admin
// endpoints continue to work unchanged.
// ============================================================================
'use strict';
const app = require('../server');

// @vercel/node wraps an Express app and serves it as a serverless function.
module.exports = app;
