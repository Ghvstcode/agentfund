// `pnpm dev:mock`: the mock API on :8788 plus Vite on :5173 pointed at it.
// Append `?scenario=empty|one|many|error|loading` to any page URL to switch data sets;
// the choice sticks for the tab until you pick another.
import { createServer } from 'vite';
import { startMockApi } from './mock-api.mjs';

const MOCK_PORT = 8788;

const scenarioSwitch = {
  name: 'agentfund:mock-scenario',
  transformIndexHtml: () => [
    {
      tag: 'script',
      injectTo: 'head-prepend',
      children: `(() => {
        const picked = new URLSearchParams(location.search).get('scenario');
        if (picked) sessionStorage.setItem('mock.scenario', picked);
        const scenario = sessionStorage.getItem('mock.scenario') || 'many';
        window.__AGENTFUND__ = { apiBase: 'http://' + location.hostname + ':${MOCK_PORT}/s/' + scenario };
      })();`,
    },
  ],
};

await startMockApi({ port: MOCK_PORT });
const vite = await createServer({ plugins: [scenarioSwitch] });
await vite.listen();
console.log(`mock API  http://localhost:${MOCK_PORT}`);
vite.printUrls();
