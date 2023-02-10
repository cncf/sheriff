import { Plugin } from './Plugin';

import { gsuitePlugin } from './gsuite';
import { slackPlugin } from './slack';
import { cncfSlackPlugin } from './cncfSlack';
import { SHERIFF_PLUGINS } from '../../constants';

const enabledPlugins = SHERIFF_PLUGINS.split(',');

export const plugins: Plugin[] = [];

if (enabledPlugins.includes('gsuite')) {
  plugins.push(gsuitePlugin);
}

if (enabledPlugins.includes('slack')) {
  plugins.push(slackPlugin);
}

if (enabledPlugins.includes('cncfSlack')) {
  plugins.push(cncfSlackPlugin);
}
