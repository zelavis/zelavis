import { expect, it } from 'vitest';
import { projectSiteUrl } from './project-site-url';
import type { RuntimeProject } from './runtime-api';
const project = { runtime: { status: 'running', url: 'http://127.0.0.1:35077' }, preview: { status: 'ready', port: 42000 } } as RuntimeProject;
it('uses the browser hostname and preview port on the VPS, locally, and with IPv6', () => {
  expect(projectSiteUrl(project,'http://138.199.147.126:3000/zelavis/')).toBe('http://138.199.147.126:42000/');
  expect(projectSiteUrl(project,'http://localhost:3001/zelavis/')).toBe('http://localhost:42000/');
  expect(projectSiteUrl(project,'http://[::1]:3000/zelavis/')).toBe('http://[::1]:42000/');
  expect(projectSiteUrl(project,'https://dashboard.example/zelavis/')).toBe('http://dashboard.example:42000/');
});
it('withholds unavailable, stopped, invalid and remote loopback links', () => {
  expect(projectSiteUrl({...project,preview:{status:'unavailable'}},'http://138.199.147.126:3000')).toBeUndefined();
  expect(projectSiteUrl({...project,runtime:{...project.runtime,status:'stopped'}},'http://localhost:3000')).toBeUndefined();
  expect(projectSiteUrl({...project,preview:undefined},'http://138.199.147.126:3000')).toBeUndefined();
  expect(projectSiteUrl({...project,preview:undefined},'http://localhost:3000')).toBe('http://127.0.0.1:35077/');
  expect(projectSiteUrl(project,'invalid')).toBeUndefined();
});
