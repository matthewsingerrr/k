/**
 * Labels resolved by the DNS wordlist sweep (`<label>.<rootDomain>`): common web/infra names plus the environments and
 * product surfaces crypto / web3 projects typically launch on. Kept to ~250 entries so one sweep is ~750 DNS queries.
 *
 * Order does not matter; duplicates and invalid entries are dropped when COMMON_SUBDOMAINS is built.
 */
export const SUBDOMAIN_WORDLIST: readonly string[] = [
  // core / web
  'www', 'app', 'apps', 'api', 'api2', 'web', 'webapp', 'home', 'm', 'mobile', 'go', 'link', 'links', 'get', 'info',
  'portal', 'dashboard', 'console', 'panel', 'admin', 'my', 'account', 'accounts', 'user', 'profile',
  // docs & content
  'docs', 'doc', 'developer', 'developers', 'api-docs', 'wiki', 'kb', 'help', 'support', 'faq', 'guide', 'guides',
  'learn', 'academy', 'blog', 'news', 'press', 'media', 'brand', 'about', 'careers', 'jobs', 'changelog', 'whitepaper',
  'litepaper', 'roadmap', 'research', 'labs', 'legal', 'terms', 'privacy', 'security', 'audit', 'audits', 'community',
  'forum', 'discord', 'events', 'partners', 'ecosystem', 'foundation', 'hackathon', 'grants', 'invest', 'investors',
  'ir',
  // environments
  'beta', 'alpha', 'staging', 'stage', 'stg', 'dev', 'test', 'qa', 'uat', 'preprod', 'prod', 'preview', 'demo',
  'sandbox', 'playground', 'canary', 'earlyaccess', 'access', 'waitlist', 'invite', 'old', 'new', 'next', 'legacy',
  'classic', 'pro', 'v1', 'v2', 'v3', 'v4', 'app2', 'app-v2', 'beta-app', 'app-staging', 'app-dev', 'api-staging',
  'api-dev', 'testnet', 'devnet', 'mainnet', 'app-testnet',
  // infra
  'status', 'uptime', 'cdn', 'static', 'assets', 'img', 'images', 'files', 'download', 'downloads', 'storage', 'cms',
  'mail', 'auth', 'login', 'signup', 'sso', 'id', 'gateway', 'ws', 'graphql', 'search', 'analytics', 'stats', 'data',
  // commerce / growth
  'pay', 'payment', 'payments', 'billing', 'checkout', 'buy', 'shop', 'store', 'market', 'marketplace', 'referral',
  'ref', 'leaderboard', 'quest', 'quests', 'rewards', 'points', 'airdrop', 'claim', 'claims', 'bot', 'tg', 'x',
  // defi / web3 product surfaces
  'wallet', 'bridge', 'swap', 'trade', 'trading', 'exchange', 'dex', 'amm', 'perp', 'perps', 'futures', 'options',
  'margin', 'spot', 'otc', 'stake', 'staking', 'restaking', 'earn', 'yield', 'vault', 'vaults', 'farm', 'pool',
  'pools', 'liquidity', 'lp', 'lend', 'lending', 'borrow', 'loans', 'credit', 'mint', 'redeem', 'peg', 'stable',
  'treasury', 'reserve', 'collateral', 'insurance', 'lock', 'bond', 'bonds', 'vesting', 'nft', 'nfts', 'collection',
  'gallery', 'drop', 'allowlist', 'whitelist', 'launch', 'launchpad', 'presale', 'sale', 'ido', 'ico', 'token',
  'tokenomics', 'governance', 'gov', 'vote', 'voting', 'snapshot', 'proposals', 'delegate', 'dao', 'portfolio',
  'explorer', 'scan', 'chain', 'rpc', 'node', 'nodes', 'validator', 'validators', 'relayer', 'sequencer', 'zk',
  'graph', 'subgraph', 'indexer', 'oracle', 'price', 'charts', 'faucet', 'ipfs', 'sol', 'solana', 'base',
];
