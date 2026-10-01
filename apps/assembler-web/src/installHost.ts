/**
 * First import of the web composition: installs the web host before the
 * module composition is evaluated (the stores read host capabilities —
 * slicers, the agent transport — when they are created).
 */
import { installHost } from '../../assembler/renderer/src/foundation/host/index.js';
import { createWebHost } from './host/webHost.js';

installHost(createWebHost());
