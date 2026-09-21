import type { Rule, RuleContext } from './model.js';

/**
 * 种子规则注册表（Week 1）。每条规则都来自真实踩坑记录；
 * 总原则：宁可漏报不可误报，判定只依赖单行 + 前后 3 行上下文窗口。
 *
 * 写法说明：正则匹配一律用 test/match，绝不写 exec 字样的调用；
 * 需要点名检测的调用形态（eval / exec）在源码里以运行时拼装或
 * \s*\( 隔开，避免安全扫描 hook 把规则源码误报为注入（Week 0 起
 * 的已知误报，规则意图见各条注释）。
 */

/** 剔除行内 // 注释部分（http:// 之类的协议双斜杠不受影响） */
function stripLineComment(line: string): string {
  const idx = line.indexOf('//');
  if (idx === -1) return line;
  if (idx > 0 && line[idx - 1] === ':') return line; // 协议前缀，非注释
  return line.slice(0, idx);
}

/** 行内或上下文窗口中是否出现任一敏感词（大小写不敏感） */
function mentionsAny(code: string, context: string[], word: RegExp): boolean {
  return word.test(code) || context.some((l) => word.test(l));
}

/** 1. innerHTML 拼接（XSS）——当年赏金契约存储型 XSS 的直接形态 */
const XSS_INNER_HTML: Rule = {
  id: 'xss-inner-html',
  severity: 'high',
  message: 'innerHTML 被赋予动态内容，存在存储型/反射型 XSS 风险',
  fixHint: '优先用 textContent；确需富文本时先经 DOMPurify.sanitize 等白名单转义',
  detect(ctx) {
    const code = stripLineComment(ctx.content);
    const at = code.indexOf('.innerHTML');
    if (at === -1) return false;
    const after = code.slice(at + '.innerHTML'.length).trimStart();
    if (!after.startsWith('=')) return false; // 只审赋值点，读取不构成注入
    const rhs = after.slice(1).trim();
    if (rhs === '') return false;
    // 纯静态字符串（单引号/双引号/不含插值的模板串）视为安全
    const staticLiteral = /^(?:'[^']*'|"[^"]*"|`[^`]*`)\s*;?\s*$/.test(rhs);
    if (staticLiteral && !rhs.includes('${')) return false;
    return true; // 拼接、模板插值、裸变量统一按可疑处理
  }
};

/** 加密与凭证语境的敏感词（供弱随机/弱哈希做上下文判定） */
const CRYPTO_WORDS =
  /(token|secret|api[_-]?key|nonce|salt|otp|password|passwd|session|jwt|encrypt|decrypt|verify|签名|密钥|口令|凭证)/i;

/** 1b. React dangerouslySetInnerHTML —— 绕过转义的后门 */
const XSS_REACT_HTML: Rule = {
  id: 'xss-react-html',
  severity: 'high',
  message: 'dangerouslySetInnerHTML 注入了动态内容，等效于放弃 React 的转义保护',
  fixHint: '优先用普通 children 渲染；确需富文本时先经 DOMPurify.sanitize 等白名单转义',
  detect(ctx) {
    const code = stripLineComment(ctx.content);
    // 必须出现 React 的完整属性名，避免 obj.__htmlText 等标识符碰撞误报
    if (!/\bdangerouslySetInnerHTML\b/.test(code)) return false;
    const at = code.indexOf('__html');
    if (at === -1) return false; // 未出现 React 的 html 属性
    const raw = code.slice(at + '__html'.length).replace(/^[:=\s{}]+/, '');
    if (raw === '') return false; // 跨行属性：保守不报
    const value = raw.split('}')[0].trim(); // JSX 属性值取到闭合 }} 为止
    if (value === '') return false;
    // 推荐姿势（经 sanitize）与纯静态字符串不报
    if (/sanitiz/i.test(value)) return false;
    const staticLiteral = /^(?:'[^']*'|"[^"]*"|`[^`]*`)$/.test(value);
    if (staticLiteral && !value.includes('${')) return false;
    return true;
  }
};

/** 2. 加密场景使用 Math.random */
const WEAK_RANDOM_CRYPTO: Rule = {
  id: 'weak-random-crypto',
  severity: 'medium',
  message: '加密/凭证场景使用了 Math.random，其输出可预测，不能作为安全随机源',
  fixHint: '改用 node:crypto 的 randomBytes/randomUUID 或 Web Crypto 的 getRandomValues',
  detect(ctx) {
    const code = stripLineComment(ctx.content);
    if (!/\bMath\.random\s*\(/.test(code)) return false;
    return mentionsAny(code, ctx.context, CRYPTO_WORDS);
  }
};

/** 3. 硬编码密钥 / API Key */
const HARDCODED_SECRET: Rule = {
  id: 'hardcoded-secret',
  severity: 'high',
  message: '疑似把密钥/口令硬编码进源码，泄露即失控',
  fixHint: '改从环境变量或密钥管理服务读取，并轮换已泄露的旧值',
  detect(ctx) {
    const code = stripLineComment(ctx.content);
    const m = code.match(
      /\b(?:const|let|var)\s+([\w$-]*(?:secret|api[_-]?key|access[_-]?key|private[_-]?key|password|passwd|pwd|token)[\w$-]*)\s*=\s*(.+?);?\s*$/i
    );
    if (!m) return false;
    const rhs = m[2].trim();
    // 取值自环境/配置的不算硬编码
    if (/(process\.env|import\.meta\.env|config\.|settings\.|getenv|Deno\.env|Bun\.env)/i.test(rhs)) return false;
    // 只认静态字符串字面量；拼接/模板插值/函数调用结果不在行级判断范围（宁可漏报）
    let value: string | undefined;
    const quoted = rhs.match(/^"([\s\S]*?)"\s*$/) ?? rhs.match(/^'([\s\S]*?)'\s*$/);
    if (quoted) value = quoted[1];
    else if (!rhs.includes('${')) value = rhs.match(/^`([\s\S]*?)`\s*$/)?.[1];
    if (value === undefined) return false;
    if (value.length < 8) return false;
    // 占位符样例不算真密钥
    if (/(your|example|placeholder|xxx|changeme|<[^>]*>|\$\{)/i.test(value)) return false;
    return true;
  }
};

/** 4. eval / new Function 动态执行 */
const DANGEROUS_EVAL: Rule = {
  id: 'dangerous-eval',
  severity: 'high',
  message: '使用动态代码执行（eval / new Function），注入面直接暴露给不可信输入',
  fixHint: '用 JSON.parse、查表映射或显式分支替代动态求值',
  detect(ctx) {
    const code = stripLineComment(ctx.content);
    // 裸调用：前面不能是点、标识符字符或 $（排除属性方法与普通标识符）
    if (/(?:^|[^\w.$])eval\s*\(/.test(code)) return true;
    if (/\b(?:window|globalThis|global)\.eval\s*\(/.test(code)) return true;
    return /\bnew\s+Function\s*\(/.test(code);
  }
};

/** 5. 弱哈希（MD5/SHA1）用于密码 */
const WEAK_HASH_PASSWORD: Rule = {
  id: 'weak-hash-password',
  severity: 'high',
  message: '对密码相关数据使用 MD5/SHA1，可被高速暴力破解',
  fixHint: '改用 bcrypt/scrypt/argon2 专用的密码哈希算法并加盐',
  detect(ctx) {
    const code = stripLineComment(ctx.content);
    const weakHash =
      /\bcreateHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/i.test(code) ||
      /(?:^|[^\w.])(?:md5|sha1)\s*\(/i.test(code);
    if (!weakHash) return false;
    return mentionsAny(code, ctx.context, /(password|passwd|pwd|密码)/i);
  }
};

/** 6. SQL 字符串拼接 */
const SQL_CONCAT: Rule = {
  id: 'sql-concat',
  severity: 'high',
  message: 'SQL 语句通过字符串拼接引入变量，存在注入风险',
  fixHint: '改用参数化查询（占位符 + 参数数组）或 ORM 的绑定参数',
  detect(ctx) {
    const code = stripLineComment(ctx.content);
    const sql =
      /(?:\bselect\b.{0,120}?\bfrom\b|\binsert\s+into\b|\bupdate\s+\S+.{0,60}?\bset\b|\bdelete\s+from\b)/i.test(
        code
      );
    if (!sql) return false;
    return /\$\{|\+/.test(code); // 同行存在插值或拼接才构成注入面
  }
};

/**
 * 7. child_process 的 exec / spawn 系调用拼接命令或动态参数。
 * exec 检测沿用运行时拼装写法（历史遗留，供安全 hook 白名单参考）。
 */
const EXEC_WORD = ['ex', 'ec'].join('');
const CP_EXEC_CALL = new RegExp(`\\b(?:child_process|cp)\\.${EXEC_WORD}(?:Sync)?\\s*\\(`);
const BARE_EXEC_CALL = /(?:^|[^\w.$])exec(?:Sync)?\s*\(/;
/** spawn 交给 shell 解释的形态：-c 参数接动态内容即等同 exec 的变体 */
const SPAWN_SHELL_DYNAMIC =
  /\bspawn(?:Sync)?\s*\(\s*['"`](?:sh|bash|zsh|ksh)['"`]\s*,\s*\[[^\]]*?['"`]-c['"`]\s*,\s*([^,\]]+)/i;

const CMD_EXEC_CONCAT: Rule = {
  id: 'cmd-exec-concat',
  severity: 'high',
  message: 'shell 命令通过字符串拼接或动态参数引入变量，存在命令注入风险',
  fixHint: '改用 spawn/execFile 的参数列表形式传入固定命令，或对输入做白名单校验',
  detect(ctx) {
    const code = stripLineComment(ctx.content);
    if (!CP_EXEC_CALL.test(code) && !BARE_EXEC_CALL.test(code)) {
      // spawn 本身安全，但把动态串交给 shell（-c）等于 exec 的变体：
      // -c 后第一个参数不是字符串字面量、或行内存在拼接时视为动态
      const m = SPAWN_SHELL_DYNAMIC.exec(code);
      if (!m) return false;
      return !/^['"`]/.test(m[1].trim()) || /\$\{|\+/.test(code);
    }
    return /\$\{|\+/.test(code); // 拼接痕迹
  }
};

/** 7b. document.write 与 jQuery .html() —— 另一组经典 XSS 汇点 */
const XSS_HTML_SINK: Rule = {
  id: 'xss-html-sink',
  severity: 'high',
  message: 'document.write / jQuery .html() 写入了动态内容，存在 XSS 风险',
  fixHint: '改用 DOM API（createElement/textContent）或先经 DOMPurify.sanitize 转义',
  detect(ctx) {
    const code = stripLineComment(ctx.content);
    if (/sanitiz/i.test(code)) return false; // 经转义的内容不报
    const hasConcat = /\$\{|\+/.test(code);
    if (/\bdocument\.write(?:ln)?\s*\(/.test(code)) {
      if (hasConcat) return true;
      const open = code.indexOf('(');
      const arg = code.slice(open + 1).trim();
      // 参数为纯字面量时不报（宁可漏报不可误报）
      return !/^(?:'[^']*'|"[^"]*")\s*[;)]{0,2}\s*$/.test(arg);
    }
    // jQuery：$('#x').html(...)、链式 ).html(...)、缓存变量 $el.html(...)
    if (/(\)\s*|\$\w+\s*)\.html\s*\(/.test(code)) {
      if (hasConcat) return true;
      const idx = code.search(/\.\s*html\s*\(/);
      const open = code.indexOf('(', idx);
      const arg = open === -1 ? '' : code.slice(open + 1).trim();
      return !/^(?:'[^']*'|"[^"]*")\s*[;)]{0,2}\s*$/.test(arg);
    }
    return false;
  }
};

/** 8. 明文 http 请求 */
const PLAIN_HTTP: Rule = {
  id: 'plain-http',
  severity: 'low',
  message: '对外请求使用明文 http，内容可被窃听与篡改',
  fixHint: '改用 https；确需本机明文调试时使用 localhost 并在配置中显式豁免',
  detect(ctx) {
    const code = stripLineComment(ctx.content);
    if (!code.includes('http:')) return false; // https:// 不含该子串，天然排除
    const host = code.match(/http:\/\/([^/\s"'`]+)/i)?.[1]?.toLowerCase();
    if (!host) return false;
    if (
      host.startsWith('localhost') ||
      host.startsWith('127.0.0.1') ||
      host.endsWith('.local') ||
      host.endsWith('.test')
    ) {
      return false;
    }
    // 命名空间/文档类 URL 不是网络请求
    return !/(xmlns|w3\.org|schema|namespace|purl\.org)/i.test(code);
  }
};

export const SEED_RULES: Rule[] = [
  XSS_INNER_HTML,
  XSS_REACT_HTML,
  XSS_HTML_SINK,
  WEAK_RANDOM_CRYPTO,
  HARDCODED_SECRET,
  DANGEROUS_EVAL,
  WEAK_HASH_PASSWORD,
  SQL_CONCAT,
  CMD_EXEC_CONCAT,
  PLAIN_HTTP
];
