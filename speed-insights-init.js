/**
 * Vercel Speed Insights Initialization
 * This file initializes Speed Insights for the TrọBill application
 */

import { injectSpeedInsights } from './node_modules/@vercel/speed-insights/dist/index.mjs';

// Initialize Speed Insights
// This will automatically track page performance metrics
injectSpeedInsights({
  debug: false // Set to true if you want to see debug logs in development
});
