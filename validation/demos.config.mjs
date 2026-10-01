import config from './playwright.config.mjs';
export default {
  ...config,
  projects: config.projects.filter(project => project.name === 'other-apps'),
  // Demo CI has no Leptos build. Readiness must use its own served artifact.
  webServer: { ...config.webServer, url: 'http://127.0.0.1:8102/' },
};
