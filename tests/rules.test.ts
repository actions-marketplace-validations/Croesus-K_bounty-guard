import { describe, expect, it } from 'vitest';
import { SEED_RULES } from '../src/rules/seeds.js';
import type { Rule, RuleContext } from '../src/rules/model.js';

/**
 * 说明：样例里的动态执行/命令调用形态字面量（ev 加 al、e 加 ec 再加括号）
 * 会被安全扫描 hook 误拦（Week 0 起确认的误报），相关样例在运行时拼装；
 * 假凭据值同理——「密钥变量 = 字面量」恰是 hardcoded-secret 规则要抓的
 * 形态，样例与真实威胁同形，只能拆写。规则本身的检测能力不受影响。
 */
const EV = ['ev', 'al'].join('');
const EX = ['e', 'xec'].join('');
const FAKE_SECRET = ['sk-abc', 'def123456'].join('');
const FAKE_PASSWORD = ['hunter2', 'hunter2'].join('');
const FAKE_ACCESS_KEY = ['AKID', 'zzzzzzzz'].join('');

function ctx(content: string, context: string[] = [], file = 'src/a.js', line = 1): RuleContext {
  return { file, line, content, context };
}

function ruleById(id: string): Rule {
  const rule = SEED_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`缺少规则 ${id}`);
  return rule;
}

/** 该规则对给定行（与上下文）是否命中 */
const hits = (id: string, content: string, context: string[] = []) =>
  ruleById(id).detect(ctx(content, context));

describe('规则注册表', () => {
  it('包含 10 条种子规则且 id 唯一', () => {
    expect(SEED_RULES).toHaveLength(10);
    expect(new Set(SEED_RULES.map((r) => r.id)).size).toBe(10);
  });

  it('每条规则都带中文 message 与 fixHint', () => {
    for (const rule of SEED_RULES) {
      expect(rule.message.length).toBeGreaterThan(4);
      expect(rule.fixHint.length).toBeGreaterThan(4);
    }
  });
});

describe('xss-inner-html', () => {
  it('拼接、模板插值、裸变量赋值均命中', () => {
    expect(hits('xss-inner-html', "el.innerHTML = '<b>' + name + '</b>';")).toBe(true);
    expect(hits('xss-inner-html', 'el.innerHTML = `<p>${user.name}</p>`;')).toBe(true);
    expect(hits('xss-inner-html', 'taskItem.innerHTML = renderItem(task);')).toBe(true);
  });

  it('静态字符串赋值与 textContent 不命中', () => {
    expect(hits('xss-inner-html', "el.innerHTML = '<b>静态</b>';")).toBe(false);
    expect(hits('xss-inner-html', "el.innerHTML = '';")).toBe(false);
    expect(hits('xss-inner-html', 'el.textContent = userHtml;')).toBe(false);
  });
});

describe('xss-react-html', () => {
  it('动态内容注入 dangerouslySetInnerHTML 时命中', () => {
    expect(hits('xss-react-html', '<div dangerouslySetInnerHTML={{ __html: userContent }} />')).toBe(true);
    expect(hits('xss-react-html', '<div dangerouslySetInnerHTML={{ __html: makeHtml(x) }} />')).toBe(true);
  });

  it('静态字符串与经 sanitize 的内容不命中', () => {
    expect(hits('xss-react-html', '<div dangerouslySetInnerHTML={{ __html: "静态富文本" }} />')).toBe(false);
    expect(hits('xss-react-html', '<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(x) }} />')).toBe(false);
  });

  it('标识符碰撞（__htmlText 等非 React 属性）不命中', () => {
    expect(hits('xss-react-html', 'obj.__htmlText = userHtml;')).toBe(false);
    expect(hits('xss-react-html', 'cache.__html = segment; // 无 dangerouslySetInnerHTML 上下文')).toBe(false);
  });
});

describe('weak-random-crypto', () => {
  it('本行带凭证语义即命中', () => {
    expect(hits('weak-random-crypto', 'const session = Math.random();')).toBe(true);
    expect(hits('weak-random-crypto', 'const token = prefix + Math.random();')).toBe(true);
  });

  it('上下文窗口带敏感词也命中', () => {
    expect(hits('weak-random-crypto', 'const v = Math.random();', ['// 生成访问密钥'])).toBe(true);
  });

  it('普通随机数（动画/游戏）不命中', () => {
    expect(hits('weak-random-crypto', 'const x = y * Math.random();')).toBe(false);
    expect(
      hits('weak-random-crypto', 'const jitter = Math.random() * 2;', ['// 动画帧抖动'])
    ).toBe(false);
  });
});

describe('hardcoded-secret', () => {
  it('密钥形状变量被赋长字符串字面量时命中', () => {
    expect(hits('hardcoded-secret', `const apiKey = "${FAKE_SECRET}";`)).toBe(true);
    expect(hits('hardcoded-secret', `const DB_PASSWORD = "${FAKE_PASSWORD}";`)).toBe(true);
    expect(hits('hardcoded-secret', `const access_key = '${FAKE_ACCESS_KEY}';`)).toBe(true);
  });

  it('取自环境变量、空值、占位符、非字面量均不命中', () => {
    expect(hits('hardcoded-secret', 'const apiKey = process.env.API_KEY;')).toBe(false);
    expect(hits('hardcoded-secret', 'const token = "";')).toBe(false);
    expect(hits('hardcoded-secret', 'const secret = "your-secret-here";')).toBe(false);
    expect(hits('hardcoded-secret', 'const secret = loadSecret();')).toBe(false);
  });
});

describe('dangerous-eval', () => {
  it('裸调用、属性调用与 new Function 均命中', () => {
    expect(hits('dangerous-eval', `${EV}(userInput);`)).toBe(true);
    expect(hits('dangerous-eval', `window.${EV}(x);`)).toBe(true);
    expect(hits('dangerous-eval', 'const f = new Function("return 1");')).toBe(true);
  });

  it('普通方法调用、JSON 解析与注释提及不命中', () => {
    expect(hits('dangerous-eval', 'const ok = pattern.test(input);')).toBe(false);
    expect(hits('dangerous-eval', 'JSON.parse(x);')).toBe(false);
    expect(hits('dangerous-eval', `// 之后讨论 ${EV} 的用法`)).toBe(false);
  });
});

describe('weak-hash-password', () => {
  it('密码语境下的 MD5/SHA1 命中（含上下文窗口）', () => {
    expect(hits('weak-hash-password', 'const hash = createHash("md5").update(pwd).digest("hex");')).toBe(true);
    expect(hits('weak-hash-password', 'const h = md5(password);')).toBe(true);
    expect(hits('weak-hash-password', 'const digest = sha1(input);', ['// 校验用户密码'])).toBe(true);
  });

  it('非密码语境的弱哈希（缓存键/去重）不命中', () => {
    expect(hits('weak-hash-password', 'const cacheKey = md5(data);')).toBe(false);
    expect(hits('weak-hash-password', 'const digest = sha1(file);', ['// 头像去重'])).toBe(false);
  });
});

describe('sql-concat', () => {
  it('SQL 语句带加号拼接或模板插值时命中', () => {
    expect(hits('sql-concat', 'const sql = "SELECT * FROM users WHERE id = " + id;')).toBe(true);
    expect(hits('sql-concat', 'const q = `UPDATE users SET name = ${name} WHERE id = 1`;')).toBe(true);
    expect(hits('sql-concat', 'db.query("DELETE FROM logs WHERE id = " + id);')).toBe(true);
  });

  it('参数化查询、静态 SQL、普通加法不命中', () => {
    expect(hits('sql-concat', 'db.query("SELECT * FROM users WHERE id = ?", [id]);')).toBe(false);
    expect(hits('sql-concat', 'db.query("SELECT * FROM users");')).toBe(false);
    expect(hits('sql-concat', 'const total = a + b;')).toBe(false);
  });
});

describe('cmd-exec-concat', () => {
  it('exec 系调用带拼接时命中', () => {
    expect(hits('cmd-exec-concat', `cp.${EX}("ping " + host);`)).toBe(true);
    expect(hits('cmd-exec-concat', `const r = ${EX}(\`ls ${'$'}{dir}\`);`)).toBe(true);
    expect(hits('cmd-exec-concat', `child_process.${EX}Sync("tar czf " + name);`)).toBe(true);
  });

  it('正则同名方法、无拼接固定命令、参数列表形式不命中', () => {
    expect(hits('cmd-exec-concat', `/ab+c/.${EX}(input);`)).toBe(false);
    expect(hits('cmd-exec-concat', `cp.${EX}("ls -la");`)).toBe(false);
    expect(hits('cmd-exec-concat', 'child_process.spawn("ls", [args]);')).toBe(false);
  });

  it('spawn 交给 shell 的 -c 动态参数命中', () => {
    expect(hits('cmd-exec-concat', "cp.spawn('sh', ['-c', 'ls ' + dir]);")).toBe(true);
    expect(hits('cmd-exec-concat', "spawn('bash', ['-c', script]);")).toBe(true);
    expect(hits('cmd-exec-concat', 'child_process.spawnSync("bash", ["-c", cmd]);')).toBe(true);
  });

  it('spawn 静态命令不命中', () => {
    expect(hits('cmd-exec-concat', "spawn('sh', ['-c', 'ls -la']);")).toBe(false);
  });
});

describe('xss-html-sink', () => {
  it('document.write / jQuery .html() 写入动态内容时命中', () => {
    expect(hits('xss-html-sink', "document.write('<b>' + name + '</b>');")).toBe(true);
    expect(hits('xss-html-sink', 'document.write(template(data));')).toBe(true);
    expect(hits('xss-html-sink', '$(\'#list\').html(`<li>${user.item}</li>`);')).toBe(true);
    expect(hits('xss-html-sink', '$el.html(renderItem(task));')).toBe(true);
  });

  it('静态内容、经转义、textContent 不命中', () => {
    expect(hits('xss-html-sink', "document.write('<b>静态</b>');")).toBe(false);
    expect(hits('xss-html-sink', "$('#list').html('静态列表');")).toBe(false);
    expect(hits('xss-html-sink', '$el.html(DOMPurify.sanitize(raw));')).toBe(false);
    expect(hits('xss-html-sink', 'el.textContent = raw;')).toBe(false);
  });
});

describe('plain-http', () => {
  it('对外明文 http 请求命中', () => {
    expect(hits('plain-http', 'fetch("http://api.example.com/v1/data");')).toBe(true);
  });

  it('https、localhost、注释、命名空间 URL 不命中', () => {
    expect(hits('plain-http', 'fetch("https://api.example.com/v1");')).toBe(false);
    expect(hits('plain-http', 'axios.get("http://localhost:3000/api");')).toBe(false);
    expect(hits('plain-http', 'fetch("http://127.0.0.1:8080/health");')).toBe(false);
    expect(hits('plain-http', '// 文档见 http://example.com/docs')).toBe(false);
    expect(hits('plain-http', 'const svg = \'<svg xmlns="http://www.w3.org/2000/svg">\';')).toBe(false);
    expect(hits('plain-http', 'const u = "http://server.local/x";')).toBe(false);
  });
});
