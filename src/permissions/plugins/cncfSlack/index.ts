import { Plugin } from '../Plugin';
import { MessageBuilder } from '../../../MessageBuilder';
import { memoize, IS_DRY_RUN } from '../../../helpers';
import { TeamConfig } from '../../types';
import chalk from 'chalk';
import {
  PERMISSIONS_FILE_ORG,
  PERMISSIONS_FILE_REPO,
  PERMISSIONS_FILE_REF,
} from '../../../constants';
import { getOctokit } from '../../../octokit';

import { WebClient } from '@slack/web-api';
import { SLACK_TOKEN } from '../../../constants';

interface UserGroup {
  id: string;
  date_delete: number;
  name: string;
  handle: string;
  users: string[];
  is_external: boolean;
}

interface SlackUser {
  id: string;
  team_id: string;
  real_name: string;
  profile: {
    email: string;
  };
  sheriff_username: string;
}

// Stub out some of the People fields
interface CncfPerson {
  name: string;
  email: string;
  github: string;
  slack_id: string;
  category: string;
}

const client = new WebClient(SLACK_TOKEN);

const getAllGroups = memoize(async () => {
  const result = await client.usergroups.list({
    include_users: true,
    include_disabled: true,
  });
  return (result.usergroups as UserGroup[]).filter((g) => !g.is_external);
});

const getAllUsers = memoize(async () => {
  const cncfBySlackID = new Map<string, CncfPerson>();
  const cncfByGithub = new Map<string, CncfPerson>();

  // Load the current people.json file
  let peopleData: CncfPerson[] = [];
  const octokit = await getOctokit(PERMISSIONS_FILE_ORG);
  const contents = await octokit.repos.getContent({
    owner: PERMISSIONS_FILE_ORG,
    repo: PERMISSIONS_FILE_REPO,
    path: "people.json",
    ref: PERMISSIONS_FILE_REF,
  });
  // @ts-ignore - Octokit fails to type properties of ReposGetContentsResponse correctly.
  peopleData = JSON.parse(Buffer.from(contents.data.content, 'base64').toString('utf8'));
  
  for (const entry of peopleData) {
    // Only add entries with a slack_id
    if (entry.slack_id != '') {
      // Pull out the GitHub username
      entry.github = entry.github.replace('https://github.com/', '').replace('//$/', '');
      cncfBySlackID.set(entry.slack_id, entry);
      cncfByGithub.set(entry.github, entry);
    }
  }
  return { cncfBySlackID, cncfByGithub };
});

const englishCommaJoin = (arr: string[]) => {
  if (arr.length <= 1) return arr.join(',');
  return `${arr.slice(0, arr.length - 2).join(', ')} and ${arr[arr.length - 1]}`;
};

class CncfSlackPlugin implements Plugin {
  handleTeam = async (team: TeamConfig, builder: MessageBuilder) => {
    // No slack, we stop here
    if (!team.slack) return;

    let groups = await getAllGroups();
    const { cncfBySlackID, cncfByGithub } = await getAllUsers();

    const groupName = team.slack === true ? team.name : team.slack;
    const userGroupName = team.displayName || team.name;
    let existingGroup = groups.find((g) => g.handle === groupName);
    if (!existingGroup) {
      builder.addContext(
        `:slack: :tada: Creating Slack User Group with handle \`${groupName}\` as it did not exist`,
      );
      console.info(
        chalk.green('Creating Slack User Group'),
        'with handle',
        chalk.cyan(groupName),
        'as it did not exist',
      );
      if (!IS_DRY_RUN) {
        const { usergroup } = await client.usergroups.create({
          handle: groupName,
          name: userGroupName,
        });
        existingGroup = {
          id: (usergroup as any).id,
          name: userGroupName,
          handle: groupName,
          date_delete: 0,
          is_external: false,
          users: [],
        };
        getAllGroups.invalidate();
        groups = await getAllGroups();
      } else {
        existingGroup = {
          id: 'NEW_USER_GROUP_ID',
          name: userGroupName,
          handle: groupName,
          date_delete: 0,
          is_external: false,
          users: [],
        };
      }
    }

    if (existingGroup.name !== userGroupName) {
      builder.addContext(
        `:slack: :pencil2: Updating Slack User Group Name for \`${existingGroup.handle}\` from \`${existingGroup.name}\` :arrow_right: \`${userGroupName}\``,
      );
      console.info(
        chalk.yellow('Updating Slack User Group Name'),
        'for',
        chalk.cyan(existingGroup.handle),
        'from',
        chalk.magenta(existingGroup.name),
        'to',
        chalk.magenta(userGroupName),
      );
      if (!IS_DRY_RUN) {
        await client.usergroups.update({
          usergroup: existingGroup.id,
          name: userGroupName,
        });
      }
    }

    const expectedUserIds: string[] = [];
    for (const username of team.maintainers.concat(team.members)) {
      const cncfUser = cncfByGithub.get(username.toLowerCase());
      if (!cncfUser) continue;
      expectedUserIds.push(cncfUser.slack_id);
    }

    existingGroup.users.sort();
    expectedUserIds.sort();
    // The users match up, let's move on
    if (JSON.stringify(existingGroup.users) === JSON.stringify(expectedUserIds)) return;

    const usernamesToRemove: string[] = [];
    const usernamesToAdd: string[] = [];
    for (const userId of expectedUserIds) {
      if (!existingGroup.users.includes(userId)) {
        usernamesToAdd.push(cncfBySlackID.get(userId)!.github);
      }
    }
    for (const userId of existingGroup.users) {
      if (!expectedUserIds.includes(userId)) {
        const cncfUser = cncfBySlackID.get(userId);
        usernamesToRemove.push(cncfUser ? `\`${cncfUser.github}\`` : `<@${userId}>`);
      }
    }

    if (usernamesToRemove.length) {
      builder.addContext(
        `:slack: :skull_and_crossbones: Evicting ${englishCommaJoin(
          usernamesToRemove,
        )} out of Slack User Group \`${existingGroup.handle}\``,
      );
      console.info(
        chalk.red('Evicting'),
        chalk.cyan(englishCommaJoin(usernamesToRemove)),
        'out of Slack User Group',
        chalk.cyan(existingGroup.handle),
      );
    }
    if (usernamesToAdd.length) {
      builder.addContext(
        `:slack: :new: Adding \`${englishCommaJoin(usernamesToAdd)}\` to Slack User Group \`${
          existingGroup.handle
        }\``,
      );
      console.info(
        chalk.green('Adding'),
        chalk.cyan(englishCommaJoin(usernamesToAdd)),
        'to Slack User Group',
        chalk.cyan(existingGroup.handle),
      );
    }
    if (!IS_DRY_RUN) {
      await client.usergroups.users.update({
        usergroup: existingGroup.id,
        users: expectedUserIds.join(','),
      });
    }
  };
}

export const cncfSlackPlugin = new CncfSlackPlugin();
