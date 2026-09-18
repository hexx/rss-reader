// 本番反映の入口をひとつに保つための番人（ADR-0019 / 0020）。
//
// 本番反映は Cloudflare Workers Builds（production branch = main）からだけ行う。
// Workers Builds のビルド環境では WORKERS_CI=1 が注入されるため、それ以外の場所
// （＝運用者の手元）からの `npm run deploy` は、明示的に許可されない限り中止する。
// 手元から出す必要があるときは ALLOW_LOCAL_DEPLOY=1 を付ける（docs/specs/deploy.md §7）。
//
// 中止する理由は「事故の予防」だけではなく、ローカルからの反映は
// 「本番で動いている成果物は main 先頭のコミットからビルドしたものである」という
// 不変条件（ADR-0019）を壊し得るため。

const inWorkersBuilds = process.env.WORKERS_CI === '1';
const allowedLocally = process.env.ALLOW_LOCAL_DEPLOY === '1';

if (!inWorkersBuilds && !allowedLocally) {
  const lines = [
    '本番反映は Cloudflare Workers Builds に一本化されています（ADR-0019）。',
    'main にマージすると自動で反映されます。手元から反映する場合だけ、次を実行してください:',
    '',
    '  npm run build && ALLOW_LOCAL_DEPLOY=1 npm run deploy',
    '',
    '手元からの反映は「本番 = main 先頭」という不変条件を壊すため、実行後は revert で追いつかせてください。',
  ];
  console.error(lines.join('\n'));
  process.exit(1);
}

if (inWorkersBuilds) {
  const branch = process.env.WORKERS_CI_BRANCH ?? '(unknown branch)';
  const sha = process.env.WORKERS_CI_COMMIT_SHA ?? '(unknown sha)';
  console.log(`Workers Builds からの本番反映: ${branch} @ ${sha}`);
} else {
  console.warn('ALLOW_LOCAL_DEPLOY=1 による手元からの本番反映です（ADR-0019 の例外）。');
}
