import { ModeratorStats, CommentOpts } from './mod_processor';
import steemAPI, { getContent } from '../server/steemAPI';
import Moderator from '../server/models/moderator.model';
import { CategoryValue, formatCat } from './util';
import User from '../server/models/user.model';
import Post from '../server/models/post.model';
import config from '../config/config';
import * as mongoose from 'mongoose';
import * as sc2 from '../server/sc2';
import { Account } from './account';
import * as assert from 'assert';
import * as util from 'util';

const TEST = process.env.TEST === 'false' ? false : true;
const DO_UPVOTE = process.env.DO_UPVOTE === 'false' ? false : true;
let POSTER_TOKEN = process.env.POSTER_TOKEN;
let UTOPIAN_TOKEN = process.env.UTOPIAN_TOKEN;
let UTOPIAN_ACCOUNT: string;

// Point value is in relation to 1 SBD
const POST_MODERATION_THRESHOLD = 1;
const POINT_VALUE = 0.75;
const MAX_POINTS = 130;

// Earnings multiplier
const CATEGORY_VALUE: { [key: string]: CategoryValue } = {
  ideas: {
    reviewed: 1.5,
    flagged: 1.5
  },
  development: {
    reviewed: 3,
    flagged: 3
  },
  translations: {
    reviewed: 3.5,
    flagged: 3.5
  },
  graphics: {
    reviewed: 2,
    flagged: 2
  },
  documentation: {
    reviewed: 2,
    flagged: 2
  },
  copywriting: {
    reviewed: 2,
    flagged: 2
  },
  tutorials: {
    reviewed: 3,
    flagged: 3
  },
  analysis: {
    reviewed: 2,
    flagged: 2
  },
  social: {
    reviewed: 1,
    flagged: 1
  },
  blog: {
    reviewed: 2,
    flagged: 2
  },
  'video-tutorials': {
    reviewed: 3,
    flagged: 3
  },
  'bug-hunting': {
    reviewed: 2,
    flagged: 2
  },
  'task-ideas': {
    reviewed: 1,
    flagged: 2
  },
  'task-development': {
    reviewed: 1,
    flagged: 2
  },
  'task-bug-hunting': {
    reviewed: 1,
    flagged: 1
  },
  'task-translations': {
    reviewed: 1,
    flagged: 1
  },
  'task-graphics': {
    reviewed: 1,
    flagged: 1
  },
  'task-documentation': {
    reviewed: 1,
    flagged: 1
  },
  'task-analysis': {
    reviewed: 1,
    flagged: 1
  },
  'task-social': {
    reviewed: 1,
    flagged: 1
  }
};

(mongoose as any).Promise = Promise;
mongoose.connect(config.mongo, {
  useMongoClient: true
});

const conn = mongoose.connection;
conn.once('open', async () => {
  try {
    POSTER_TOKEN = (await sc2.getToken(POSTER_TOKEN as any, true)).access_token;
    UTOPIAN_TOKEN = (await sc2.getToken(UTOPIAN_TOKEN as any, true)).access_token;

    const utopian = await sc2.send('/me', {
      token: UTOPIAN_TOKEN
    });
    UTOPIAN_ACCOUNT = utopian.name;
    if (!TEST && DO_UPVOTE) {
      const acc = new Account(utopian);
      const power = acc.getRecoveredPower();
      if (power < 9900) {
        throw new Error('Not enough power, currently at ' + power);
      }
    }

    // Run the payment script
    await run();
  } catch(e) {
    console.log('Error running pay script', e);
  }
  conn.close();
});

async function run() {
  const moderators = await ModeratorStats.list();

  let mainPost;
  { // Generate global post
    const totalReviewed: number = moderators.reduce((prev, cur) => {
      return typeof(prev) === 'number'
              ? prev + cur.totalReviewed
              : prev.totalReviewed + cur.totalReviewed as any;
    }) as any;
    const totalFlagged: number = moderators.reduce((prev, cur) => {
      return typeof(prev) === 'number'
              ? prev + cur.totalFlagged
              : prev.totalFlagged + cur.totalFlagged as any;
    }) as any;

    mainPost =
`\
![utopian-post-banner.png](https://res.cloudinary.com/hpiynhbhq/image/upload/v1516449865/t0gmipslwoa6htmribn7.png)\

This is an automated weekly reward post for moderators from @utopian-io. Each \
comment is generated for the moderator and receives an upvote as reward for \
contributions to Utopian.\

In total for this week, there were ${totalReviewed} posts reviewed and \
${totalFlagged} posts flagged. ${(totalReviewed / (totalFlagged + totalReviewed) * 100).toFixed(0)}% \
of the total amount of posts were accepted by moderators.
`;

    const cats: { [key: string]: CategoryValue } = {};
    for (const mod of moderators) {
      for (const catKey in mod.categories) {
        let cat = cats[catKey];
        if (!cats[catKey]) {
          cat = cats[catKey] = {
            reviewed: 0,
            flagged: 0
          };
        }
        cat.reviewed += mod.categories[catKey].reviewed;
        cat.flagged += mod.categories[catKey].flagged;
      }
    }

    for (const key in cats) {
      mainPost +=
`
### ${formatCat(key)} Category
- ${cats[key].reviewed} post${cats[key].reviewed === 1 ? '' : 's'} reviewed
- ${cats[key].flagged} post${cats[key].flagged === 1 ? '' : 's'} flagged
`;
    }
  }

  {
    // Calculate raw rewards without the bound cap applied
    for (const mod of moderators) {
      let referrer: any|undefined = mod.moderator.referrer;
      if (referrer && (mod.moderator.supermoderator === true
                        || referrer.supermoderator !== true)) {
        referrer = undefined;
      }

      let totalPoints = mod.rewards;
      for (const catKey in mod.categories) {
        assert(CATEGORY_VALUE[catKey], 'category ' + catKey + ' is missing from the reward registry');
        const cat = mod.categories[catKey];
        const reviewedPoints = cat.reviewed * CATEGORY_VALUE[catKey].reviewed * POINT_VALUE;
        const flaggedPoints = cat.flagged * CATEGORY_VALUE[catKey].flagged * POINT_VALUE;
        totalPoints += reviewedPoints + flaggedPoints;
        if (referrer) {
          let ref = moderators.filter(val => {
            return val.moderator.account === referrer;
          })[0];
          if (ref) {
            ref.rewards += reviewedPoints + flaggedPoints;
          }
        }
      }

      if (mod.totalReviewed + mod.totalFlagged >= POST_MODERATION_THRESHOLD) {
        mod.rewards = totalPoints;
      }
    }

    // Normalize the rewards
    for (const mod of moderators) {
      if (mod.moderator.supermoderator === true) {
        // Supervisors receive a 20% bonus
        mod.rewards *= 1.20;
      }
      mod.rewards = Math.min(mod.rewards, MAX_POINTS)
    }

    { // It's show time!
      const account = await Account.get(UTOPIAN_ACCOUNT);

      {
        const payout = await account.estimatePayout(10000);
        console.log('Estimated current 100% vote is worth $' + payout + ' SBD');

        const est = await account.estimateWeight(payout);
        console.log('Estimated weight value for $' + payout + ' SBD is ' + est);
      }

      const author = (await sc2.send('/me', {
        token: POSTER_TOKEN
      })).name;
      const date = new Date();
      const dateString = date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate();
      const title = 'Utopian Moderator Payout - ' + dateString;
      const permlink = 'utopian-pay-' + dateString.replace(/\//g, '-');

      const operations: any[] = [
        ['comment',
          {
            parent_author: '',
            parent_permlink: TEST ? 'testcategory' : 'utopian-mods',
            author,
            permlink,
            title,
            body: mainPost,
            json_metadata : JSON.stringify({})
          }
        ]
      ];

      let existingContent = await getContent(author, permlink);
      if (!(existingContent.author && existingContent.permlink)) {
        operations.push([
          'comment_options',
          {
            author,
            permlink,
            allow_curation_rewards: false,
            allow_votes: true,
            max_accepted_payout: '0.000 SBD',
            percent_steem_dollars : 10000,
          }
        ]);
      }

      console.log('BROADCASTING MAIN POST:', util.inspect(operations));
      if (!TEST) {
        await sc2.send('/broadcast', {
          token: POSTER_TOKEN,
          data: {
            operations
          }
        });
      }

      for (const mod of moderators) {
        if (!mod.rewards) {
          continue;
        }
        try {
          await broadcast(mod, account, {
            parentAuthor: author,
            parentPermlink: permlink,
            permlink: permlink,
            title
          });
        } catch (e) {
          // TODO: parse the error and try again if possible
          console.log('BROADCAST FAILED', e);
        }
      }
    }
  }
}

async function broadcast(mod: ModeratorStats,
                          account: Account,
                          opts: CommentOpts) {
  const operations = mod.getCommentOps(opts);
  console.log('BROADCASTING MODERATOR COMMENT\n' + util.inspect(operations));
  if (!TEST) {
    const user = await User.get(mod.moderator.account);
    await sc2.send('/broadcast', {
      user,
      data: {
        operations
      }
    });
  }

  const weight = await account.estimateWeight(mod.rewards);
  console.log('BROADCASTING UPVOTE FOR $' + mod.rewards + ' SBD (weight: ' + weight + ')');
  if (!TEST && DO_UPVOTE) {
    await sc2.send('/broadcast', {
      token: UTOPIAN_TOKEN,
      data: {
        operations: [[
          'vote',
          {
            author: mod.moderator.account,
            permlink: opts.permlink,
            weight
          }
        ]]
      }
    });
  }
}
