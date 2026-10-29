import { chromium } from '@playwright/test';
import checkBrowserStartup from './browser-startup.mjs';
import { requireHardwareRenderer } from './gpu-renderer.mjs';

export default async function checkGpuStartup(config) {
  const finish = await checkBrowserStartup(config);
  try {
    const { channel, launchOptions } = config.projects[0].use;
    const browser = await chromium.launch({ ...launchOptions, channel, headless: true });
    try {
      const page = await browser.newPage();
      const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const extension = gl?.getExtension('WEBGL_debug_renderer_info');
        return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
      });
      console.log(`GPU validation renderer: ${requireHardwareRenderer(renderer)}`);
    } finally {
      await browser.close();
    }
  } catch (error) {
    await finish();
    throw error;
  }
  return finish;
}
