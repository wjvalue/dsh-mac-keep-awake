# dsh-mac-keep-awake

> English: [README.en.md](./README.en.md)

会话进行时不让 Mac 空闲休眠的 DeepSeek Harness 插件。

> While any DSH session is running, hold a macOS power assertion so the machine
> does not idle-sleep and interrupt the session.

## 它做什么

只要**有任意一个 DSH 会话处于运行中**，插件就持有一次 macOS 电源断言
（`PreventUserIdleSystemSleep`）；**最后一个会话结束后立即释放**。

- ✅ 会话跑长任务时，Mac 不会因为空闲而休眠，任务不会被打断
- ✅ 屏幕**照常可以息屏**（用的是 `caffeinate -i`，不是 `-i -d`），长时间跑不会一直亮着
- ✅ 多个会话只持有一个断言（按 session id 引用计数）
- ✅ DSH 进程崩溃也不会把电脑永久钉住（见下方 `-w` 说明）

## 工作原理

断言由子进程 `caffeinate -i -w <DSH 主进程 pid>` 提供：

| 参数 | 作用 |
| --- | --- |
| `-i` | 只阻止**系统空闲休眠**，**不**阻止屏幕息屏 |
| `-w <pid>` | 被监视的进程退出时，caffeinate 自己退出 —— 崩溃安全网 |
| `-d` | （可选，默认关）同时阻止屏幕息屏 |
| `-t <秒>` | （可选，默认关）兜底超时，到点自动释放 |

### 断言断了怎么办：两条阶梯，都不终止

子进程有三种结束方式，含义完全不同：

| 结束方式 | 含义 | 处理 |
| --- | --- | --- |
| `error` 事件 / 退出码非 0 | 这次尝试**失败** | 失败阶梯 |
| 退出码 0 且无信号，且**活够了 1 秒** | 正常结束（`-t` 到点就是这样），这一轮**确实起到了作用** | 清零计数，1 秒后重新获取 |
| 退出码 0，但**瞬间**就退出，连续 3 次 | 可执行文件是坏的（比如指到 `/usr/bin/true`） | 升级到失败阶梯，避免空转 |

> 为什么用"活了多久"而不是只看退出码：`maxHours` 设得很短时，`-t` 会**反复**到点。
> 每一次都是功能在正常工作；如果按次数累计，三次之后就会把一份**健康配置**误判成故障
> —— 那正是最初 BUG 1 的同一类错误。（这是我自己修完 BUG 1 后引入、又自己抓出来的。）

失败阶梯是指数退避、**上限 60 秒**，而且**永不终止**：超过 3 次之后只把那条
error 打**一次**，然后继续按 60 秒的节奏重试。这样即使原因是暂时的（工具没装好、
路径写错后又被修正），插件也会**自己恢复**，不需要任何状态变化来触发。

> 为什么不做成"放弃"：会话还在跑、断言却永久没了，是最糟的结果 —— 而且旧实现里
> `reconcile` 在集合没变时是空操作，一旦放弃就再也回不来。
> （这正是独立验证时被抓出来的 BUG 1 + BUG 2。）

子进程活过 5 秒会被记为"健康"，两条阶梯清零 —— 否则一次已经恢复的故障会让插件
在**下一次**真的坏掉时保持沉默。该计时器带 generation 校验，过期的计时器不会
误重置已经替换掉的子进程。

### 释放：SIGTERM → 2 秒 → SIGKILL

释放时先发 `SIGTERM`；2 秒内没确认退出就升级 `SIGKILL`，避免"控制器报告已释放、
机器却还被钉着"。

**待升级的句柄会被一直跟踪，而不是只跟踪计时器。** `release()` 会立刻把 `child`
置空，所以如果只跟踪计时器，`dispose()` 一旦把待触发的计时器清掉，那个忽略
`SIGTERM` 的子进程就**永远不会被杀**，插件事后还会报告"全部已释放"。
因此 `escalations` 存的是 `{ handle, timer }`。

> 这是独立验证抓出来的第 4 个真实缺陷（BUG 3 的补丁没覆盖到 teardown 路径）。

#### `dispose()` 对未决升级**两者都不做**

发现上述缺陷后，第一版修法是 `flushEscalations()`：dispose 时对未确认退出的句柄
**立刻**补发 `SIGKILL`。但独立验证马上又抓出这个修法自己的问题 ——
`exited()` 要等异步的 `exit` 事件落地才为真，所以一个**守规矩**的子进程在自己
的宽限窗口里仍然读作"活着"，于是被白白补了一发 `SIGKILL`（真机 10/10 复现）。

所以现在 `dispose()` 既不取消、也不强制执行这些计时器，而是**让它们按原定时间
自己触发**（`settleEscalations()` 是个有意的空实现）：

- 到点时会**重新检查** `exited()`；
- 守规矩的子进程已经退出 → 不补信号；
- 忽略 `SIGTERM` 的子进程仍然没退出 → 照常 `SIGKILL`。

计时器都是 `unref()` 的，不会拖住进程；即使宿主在这之前退出，
`caffeinate -w <host pid>` 仍是最后一道保险。

> 两个"显而易见"的写法都是错的，而且都是被独立验证抓出来的 —— 这是
> `settleEscalations()` 里那段注释存在的意义：防止以后有人把它"清理"回去。

### 信号与对账

1. **`agent/status`** —— 权威的每会话 running/idle 转换，由 agent loop 自己发出。
   事件虽是 agent 作用域的，但本插件从根级别加载（上下文未打 scope 标签），
   cordis 的 scope 载体过滤器会放行未打标签的监听者，所以不加 `{ global: true }`
   也能收到。监听时**仍然带上**该选项，作为廉价保险：万一未来 loader 把宿主插件
   放进 agent 作用域内加载，普通监听会被过滤掉，带了这个选项不受影响。
   （实证：用本机 app 内的 cordis 4.0.4 + dsh-scope 复核过；宿主自带的
   api-session-controller / compaction-basic / agent-team / subagent 监听同样
   的事件时都没传这个选项。）
2. **`agent/disposed`** —— 会话在仍被标记为 running 时被销毁的兜底释放
   （同样带上 `{ global: true }`，理由同上）。
3. **`session/event` 里的 `compaction/start` … `compaction/end`** —— 补 `maintenance` 盲区，见下。
4. **周期性对账 `ctx.agents.list()`** —— 兜住事件覆盖不到的情况：
   插件热重载时**已经在运行**的会话，或者 fiber 被替换期间漏掉的 idle 转换。
   对账是权威的（整体替换集合），所以既能获取也能释放；同时把仍开着 compaction
   括号的会话并进去（注册表看不见它们）。

> 为什么必须有对账：插件热重载（`patchReload: live`）后，如果没有对账，
> 它会一直空等到下一个回合边界才可能拿到断言 —— 而"刚装上插件"正是最需要它的时刻。

计数以 session id 存进 `Set`，所以同一个会话重复收到 `running` 永远不会把计数抬高。

> Host 另外还会广播 `api-session/status`，但**故意没有订阅**：它就是由
> `agent/status` 在同一次派发里派生的，订阅它只会多一条永远不可能产生分歧的代码路径。

#### `maintenance` 盲区（已覆盖）

`Agent.status` 对 **`idle` 和 `maintenance` 两个阶段都返回 `'idle'`**：

```js
get status() { return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running' }
```

而手动 `/compact` 正是跑在 `runMaintenance` 里的。这台机器**用电池时 60 秒就休眠**，
所以一个长时间 compaction 如果被当成 idle，就是一个真实的休眠窗口；
`agent/status` 也看不到它（只在状态**变化**时才发，idle→maintenance 不算变化）。

由于没有公开的 phase 访问器，插件改为订阅持久化的 `compaction/start` / `compaction/end`
括号：括号开着就一直持有断言。自动压缩（在 `agent/pre-step` 里跑）本来就处于 running，
不需要这条；它只为手动 `/compact` 补位。

> 括号若因崩溃永不闭合：`maxHours`（若配置）或下一次对账会收敛，
> 因为对账对"非压缩中的会话"是权威的。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖这一行的 `config`：

```yaml
- id: keep-awake
  name: 'dsh-mac-keep-awake'
  config:
    enabled: true            # 总开关
    preventDisplaySleep: false  # true = 屏幕也不息屏（加 -d）
    maxHours: 0              # >0 = 兜底超时（小时），到点自动释放
    reconcileSeconds: 60     # 对账间隔；0 = 关闭对账
    executable: /usr/bin/caffeinate
```

## 安装

```bash
# 1. 打包并暂存到 profile 的 vendor/ 目录
node scripts/install.mjs

# 2. 用 DSH 插件管理器装（desktop profile 只能由 Electron 应用管理）
#    spec: file:vendor/dsh-mac-keep-awake-1.4.1.tgz
```

安装后 bundle 自带的 `cordis.patch.yml` 会插入 Host 半身；
`patchReload: live` 意味着改完 `src/` 重新安装即可生效，无需重启应用。

## 验证

```bash
node --test test/*.test.js
```

- `test/keep-awake.test.js` —— 34 个单元测试，注入假 spawn 与可控时钟，验证**计数与阶梯逻辑**：
  重复事件、交错 enter/leave、对账与事件竞争、过期回调不能复活句柄、
  正常退出（退出码 0）不算失败、带信号退出仍算失败、
  反复的正常到期不会升级、瞬间正常退出会升级、失败阶梯不终止且能自愈、
  健康计时器重置阶梯、过期健康计时器不误重置、
  SIGTERM 无效时升级 SIGKILL、**dispose 不会漏掉还在宽限期里的子进程**、
  非 darwin 平台降级。
- `test/wiring.test.js` —— 15 个接线测试，用假 cordis ctx 验证 `index.js`：
  `{ global: true }` 回归守卫（验证每个 agent 事件恰好注册一次且带该选项）、
  热重载时对已在运行的会话立即获取、malformed payload 不抛异常、
  手动 `/compact` 期间仍持有断言、对账不会丢掉开着的 compaction 括号、
  压缩中被销毁的会话不会永久钉住机器、
  以及"不留下任何 caffeinate 进程"。
- `test/integration.pmset.test.js` —— 2 个**真机**测试，直接读内核账本
  `pmset -g assertions`：断言真的出现、真的只有一个、真的在最后一个会话结束时消失；
  以及被监视进程被 `SIGKILL` 后 caffeinate 自行退出。

手工确认真机状态：

```bash
pmset -g assertions | grep -A2 caffeinate
#   pid 89135(caffeinate): ... PreventUserIdleSystemSleep named: "caffeinate command-line tool"
#       Details: caffeinate asserting on behalf of Process ID 87704
pgrep -fl "caffeinate -i -w"
```

会话跑完后再执行一次，应当**什么都不输出**。

## 平台支持

仅 macOS（`caffeinate` 是 macOS 专有工具）。其他平台上插件会正常加载但只打一条
warning，不持有任何断言，也不会报错 —— 它不会让 DSH 起不来。

## 目录

```
index.js                      # Host 半身：事件接线、对账循环、Config
src/keep-awake.js             # 引用计数控制器（纯逻辑，可注入）
test/keep-awake.test.js       # 控制器单元测试（假 spawn）
test/wiring.test.js           # index.js 接线测试（假 cordis ctx + 真 pmset）
test/integration.pmset.test.js# 真机 pmset 集成测试
cordis.patch.yml              # bundle patch：一行 insert 挂载 Host 半身
scripts/install.mjs           # 打包 + 暂存到 profile vendor/
```

## License

MIT
