const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, execFile } = require('child_process')
const { promisify } = require('util')
const run = promisify(execFile)

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects')

// Node shapes: { kind: 'worktree'|'claude'|'terminals'|'code'|'jira'|'metro'|'session'|'terminal'|'newTerminal', id, worktree, ... }

function repoRoot() {
  const configured = vscode.workspace.getConfiguration('petrWorkbench').get('repoRoot')
  return configured || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

// Git lists the main checkout first, so the tree is the same no matter which worktree's window runs it.
function listWorktrees(cwd) {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' })
  return out
    .split('\n\n')
    .filter(Boolean)
    .map((block, i) => {
      const dir = block.match(/^worktree (.+)$/m)?.[1]
      const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]
      const name = i === 0 ? 'Root' : path.basename(dir)
      const ticket = (name.match(/[A-Z]+-\d+/) ?? branch?.match(/[A-Z]+-\d+/))?.[0]
      return { dir, branch, name, ticket, isRoot: i === 0 }
    })
    .sort((a, b) => (a.isRoot ? -1 : b.isRoot ? 1 : a.name.localeCompare(b.name)))
}

// Claude stores sessions in a folder named after the cwd with every "/" and "." turned into "-".
function claudeProjectDir(dir) {
  return path.join(CLAUDE_PROJECTS, dir.replace(/[/.]/g, '-'))
}

// Only the head of a transcript is scanned: the title is in the first user message and a session that
// moved into a worktree does so early. Sessions are append-only, so once a file passes the cap its head
// never changes and the cache stays valid on size alone.
const SCAN_CAP = 4 * 1024 * 1024
const MIN_WORKTREE_MENTIONS = 5
const sessionCache = new Map()

// One pass over the transcript head: the title comes from the first user message, the worktree from the
// .worktrees/<name> path Claude's own tool calls touched most. Tool results are ignored because they can
// quote any path, for example a process listing.
function scanTranscript(text) {
  let title
  const counts = new Map()
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const content = entry.message?.content
    if (entry.type === 'custom-title' && entry.customTitle) title = entry.customTitle
    if (entry.type === 'summary' && entry.summary && !title) title = entry.summary
    if (entry.type === 'user' && !entry.isSidechain && !title) {
      const texts = typeof content === 'string' ? [content] : (content ?? []).filter((c) => c.type === 'text').map((c) => c.text)
      const clean = texts
        .map((t) => t.replace(/<(\w[\w-]*)>[\s\S]*?<\/\1>/g, '').trim())
        .find(Boolean)
      if (clean) title = clean.split('\n')[0].slice(0, 80)
    }
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        for (const m of JSON.stringify(block.input).matchAll(/\.worktrees\/([A-Za-z0-9._-]+)/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
      }
    }
  }
  const [name, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? []
  return { title, worktreeName: count >= MIN_WORKTREE_MENTIONS ? name : undefined }
}

async function sessionInfo(file, size) {
  const key = `${file}:${Math.min(size, SCAN_CAP)}`
  if (sessionCache.has(key)) return sessionCache.get(key)
  const fh = await fs.promises.open(file, 'r')
  const buf = Buffer.alloc(Math.min(size, SCAN_CAP))
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
  await fh.close()
  const text = buf.toString('utf8', 0, bytesRead)
  const info = scanTranscript(text)
  sessionCache.set(key, info)
  return info
}

async function listSessions(dir) {
  const projectDir = claudeProjectDir(dir)
  if (!fs.existsSync(projectDir)) return []
  const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))
  const sessions = await Promise.all(
    files.map(async (f) => {
      const file = path.join(projectDir, f)
      const stat = fs.statSync(file)
      return { id: path.basename(f, '.jsonl'), file, originDir: dir, mtime: stat.mtimeMs, ...(await sessionInfo(file, stat.size)) }
    }),
  )
  return sessions.filter((s) => s.title)
}

// Sessions per worktree dir. A session started in the root that clearly worked in a worktree is listed there.
async function sessionsByWorktree(worktrees) {
  const byDir = new Map(await Promise.all(worktrees.map(async (w) => [w.dir, await listSessions(w.dir)])))
  const root = worktrees.find((w) => w.isRoot)
  if (root) {
    const stay = []
    for (const s of byDir.get(root.dir)) {
      const target = worktrees.find((w) => !w.isRoot && w.name === s.worktreeName)
      target ? byDir.get(target.dir).push(s) : stay.push(s)
    }
    byDir.set(root.dir, stay)
  }
  for (const list of byDir.values()) list.sort((a, b) => b.mtime - a.mtime)
  return byDir
}

function terminalCwd(terminal) {
  const cwd = terminal.shellIntegration?.cwd ?? terminal.creationOptions?.cwd
  return typeof cwd === 'string' ? cwd : cwd?.fsPath
}

// A terminal belongs to the worktree whose path is its longest matching prefix. Unknown cwd falls back to Root.
function terminalsFor(worktree, worktrees) {
  return vscode.window.terminals.filter((t) => {
    const cwd = terminalCwd(t)
    if (!cwd) return worktree.isRoot
    return ownerOf(cwd, worktrees)?.dir === worktree.dir
  })
}

// Parse lsof -F output into one record per process: { pid, names: [...] }.
function lsofRecords(out) {
  const records = []
  for (const line of out.split('\n')) {
    if (line[0] === 'p') records.push({ pid: Number(line.slice(1)), names: [] })
    else if (line[0] === 'n') records.at(-1)?.names.push(line.slice(1))
  }
  return records
}

// Metro servers on this machine: [{ pid, port, cwd }]. Any node process that listens on TCP and answers
// Metro's /status endpoint counts. The cwd tells which worktree it belongs to.
async function listMetros() {
  const listening = await run('lsof', ['-c', 'node', '-a', '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-Fpn']).then((r) => lsofRecords(r.stdout), () => [])
  if (!listening.length) return []
  const cwds = await run('lsof', ['-a', '-p', listening.map((r) => r.pid).join(','), '-d', 'cwd', '-Fpn']).then((r) => lsofRecords(r.stdout), () => [])
  const cwdOf = new Map(cwds.map((r) => [r.pid, r.names[0]]))
  const candidates = listening.flatMap((r) =>
    r.names.map((n) => ({ pid: r.pid, port: Number(n.split(':').pop()), cwd: cwdOf.get(r.pid) })).filter((c) => c.cwd && c.port),
  )
  const checks = candidates.map((c) =>
    fetch(`http://localhost:${c.port}/status`, { signal: AbortSignal.timeout(1000) })
      .then((res) => res.text())
      .then((text) => (text.startsWith('packager-status:running') ? c : null), () => null),
  )
  const metros = (await Promise.all(checks)).filter(Boolean).sort((a, b) => a.port - b.port)
  for (const m of metros) m.devices = await metroDevices(m.port)
  return metros
}

// Device names of the apps attached to a Metro server, from its inspector endpoint.
async function metroDevices(port) {
  return fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
    .then((res) => res.json())
    .then((list) => [...new Set(list.map((d) => d.deviceName).filter((n) => n && n !== 'Unknown'))], () => [])
}

// Bring the simulator or emulator running the app to the front. iOS simulators are matched by name to a
// booted device; anything else is assumed to be the Android emulator.
async function focusDevice(deviceName) {
  const booted = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']).then((r) => Object.values(JSON.parse(r.stdout).devices).flat(), () => [])
  const sim = booted.find((d) => d.name === deviceName)
  if (sim) return run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', sim.udid])
  if (booted.length && !deviceName) return run('open', ['-a', 'Simulator'])
  return run('osascript', ['-e', 'tell application "System Events" to set frontmost of first process whose name contains "qemu" to true'])
}

// The Claude extension only finds sessions of the folder its window has open. Sessions from another
// folder are handed to that folder's window through a request file in global storage, which every
// window of this extension watches. Opening the folder focuses its window or creates one.
function isCurrentWorkspace(dir) {
  return (vscode.workspace.workspaceFolders ?? []).some((f) => path.resolve(f.uri.fsPath) === path.resolve(dir))
}

async function openSession(session, requestFile) {
  if (isCurrentWorkspace(session.originDir)) return vscode.commands.executeCommand('claude-vscode.editor.open', session.id)
  fs.writeFileSync(requestFile, JSON.stringify({ dir: session.originDir, sessionId: session.id, at: Date.now() }))
  return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(session.originDir), { forceNewWindow: true })
}

function takeSessionRequest(requestFile) {
  let request
  try {
    request = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
  } catch {
    return
  }
  if (!isCurrentWorkspace(request.dir) || Date.now() - request.at > 60000) return
  fs.unlinkSync(requestFile)
  vscode.commands.executeCommand('claude-vscode.editor.open', request.sessionId)
}

function ticketUrl(worktree) {
  return vscode.workspace.getConfiguration('petrWorkbench').get('jiraBaseUrl') + worktree.ticket
}

function ownerOf(cwd, worktrees) {
  return worktrees.filter((w) => cwd === w.dir || cwd.startsWith(w.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0]
}

class Provider {
  constructor() {
    this.emitter = new vscode.EventEmitter()
    this.onDidChangeTreeData = this.emitter.event
    this.worktrees = []
    this.metros = []
    this.sessions = new Map()
    this.gen = new Map()
    this.expanded = new Set()
  }

  refresh() {
    this.emitter.fire()
  }

  // Ids carry a per-worktree generation. VS Code keeps expansion state by id, so bumping the
  // generation re-renders the subtree as new, collapsed items. This is the only way to collapse a node.
  idFor(w, suffix) {
    return `${w.dir}#${this.gen.get(w.dir) ?? 0}:${suffix}`
  }

  collapse(w) {
    this.gen.set(w.dir, (this.gen.get(w.dir) ?? 0) + 1)
    this.expanded.delete(w.dir)
    this.refresh()
  }

  async getChildren(node) {
    if (!node) {
      const root = repoRoot()
      this.worktrees = root ? listWorktrees(root) : []
      this.metros = await listMetros()
      this.sessions = await sessionsByWorktree(this.worktrees)
      return this.worktrees.map((w) => ({ kind: 'worktree', id: this.idFor(w, 'worktree'), worktree: w }))
    }
    const w = node.worktree
    switch (node.kind) {
      case 'worktree':
        return [
          ...['claude', 'terminals', 'code', ...(w.ticket ? ['jira'] : [])].map((kind) => ({ kind, id: this.idFor(w, kind), worktree: w, parent: node })),
          ...this.metros
            .filter((m) => ownerOf(m.cwd, this.worktrees)?.dir === w.dir)
            .map((m) => ({ kind: 'metro', id: this.idFor(w, `metro:${m.port}`), worktree: w, metro: m, parent: node })),
        ]
      case 'claude':
        return (this.sessions.get(w.dir) ?? []).map((s) => ({ kind: 'session', id: this.idFor(w, `session:${s.id}`), worktree: w, session: s, parent: node }))
      case 'terminals':
        return [
          { kind: 'newTerminal', id: this.idFor(w, 'newTerminal'), worktree: w, parent: node },
          ...terminalsFor(w, this.worktrees).map((t) => ({ kind: 'terminal', id: this.idFor(w, `terminal:${t.name}:${t.processId}`), worktree: w, terminal: t, parent: node })),
        ]
      default:
        return []
    }
  }

  getParent(node) {
    return node.parent
  }

  getTreeItem(node) {
    const { Collapsed, None } = vscode.TreeItemCollapsibleState
    const w = node.worktree
    switch (node.kind) {
      case 'worktree': {
        const item = new vscode.TreeItem(w.name, Collapsed)
        item.id = node.id
        item.description = w.branch
        item.tooltip = w.dir
        item.iconPath = new vscode.ThemeIcon(w.isRoot ? 'repo' : 'git-branch')
        item.contextValue = 'worktree'
        return item
      }
      case 'claude': {
        const item = new vscode.TreeItem('Claude', Collapsed)
        item.id = node.id
        item.iconPath = new vscode.ThemeIcon('comment-discussion')
        return item
      }
      case 'terminals': {
        const item = new vscode.TreeItem('Terminals', Collapsed)
        item.id = node.id
        item.iconPath = new vscode.ThemeIcon('terminal')
        item.contextValue = 'terminals'
        return item
      }
      case 'code': {
        const item = new vscode.TreeItem('Code', None)
        item.id = node.id
        item.iconPath = new vscode.ThemeIcon('vscode')
        item.command = { command: 'petrWorkbench.openCode', title: 'Open in VS Code', arguments: [node] }
        return item
      }
      case 'session': {
        const item = new vscode.TreeItem(node.session.title, None)
        item.id = node.id
        item.description = new Date(node.session.mtime).toLocaleString()
        item.tooltip = node.session.id
        item.iconPath = new vscode.ThemeIcon('comment')
        item.contextValue = 'session'
        item.command = { command: 'petrWorkbench.openSession', title: 'Open Claude Session', arguments: [node] }
        return item
      }
      case 'terminal': {
        const item = new vscode.TreeItem(node.terminal.name, None)
        item.id = node.id
        item.iconPath = new vscode.ThemeIcon('terminal')
        item.command = { command: 'petrWorkbench.showTerminal', title: 'Show Terminal', arguments: [node] }
        return item
      }
      case 'jira': {
        const item = new vscode.TreeItem(w.ticket, None)
        item.id = node.id
        item.tooltip = ticketUrl(w)
        item.iconPath = new vscode.ThemeIcon('link-external')
        item.command = { command: 'petrWorkbench.openTicket', title: 'Open Ticket', arguments: [node] }
        return item
      }
      case 'metro': {
        const item = new vscode.TreeItem(`Metro :${node.metro.port}`, None)
        item.id = node.id
        item.description = node.metro.devices.join(', ') || path.relative(w.dir, node.metro.cwd)
        item.tooltip = `pid ${node.metro.pid}`
        item.iconPath = new vscode.ThemeIcon('device-mobile')
        item.command = { command: 'petrWorkbench.focusDevice', title: 'Show Simulator', arguments: [node] }
        return item
      }
      case 'newTerminal': {
        const item = new vscode.TreeItem('New terminal', None)
        item.id = node.id
        item.iconPath = new vscode.ThemeIcon('add')
        item.command = { command: 'petrWorkbench.newTerminal', title: 'New Terminal', arguments: [node] }
        return item
      }
    }
  }
}

function activate(context) {
  const storageDir = context.globalStorageUri.fsPath
  fs.mkdirSync(storageDir, { recursive: true })
  const requestFile = path.join(storageDir, 'open-session.json')
  takeSessionRequest(requestFile)
  const requestWatcher = fs.watch(storageDir, () => fs.existsSync(requestFile) && takeSessionRequest(requestFile))
  context.subscriptions.push({ dispose: () => requestWatcher.close() })

  const provider = new Provider()
  const tree = vscode.window.createTreeView('petrWorkbench.tree', { treeDataProvider: provider })

  const expand = (node) => tree.reveal(node, { expand: 3 })
  const toggle = (node) => (provider.expanded.has(node.worktree.dir) ? provider.collapse(node.worktree) : expand(node))
  const expandWhere = async (test) => {
    for (const node of await provider.getChildren()) if (test(node.worktree)) await expand(node)
  }
  const newTerminal = (node) => vscode.window.createTerminal({ name: node.worktree.name, cwd: node.worktree.dir }).show()

  context.subscriptions.push(
    tree,
    vscode.commands.registerCommand('petrWorkbench.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('petrWorkbench.expandAll', async () => {
      const nodes = await provider.getChildren()
      const allExpanded = nodes.every((n) => provider.expanded.has(n.worktree.dir))
      for (const node of nodes) allExpanded ? provider.collapse(node.worktree) : await expand(node)
    }),
    vscode.commands.registerCommand('petrWorkbench.expandWorktree', toggle),
    vscode.commands.registerCommand('petrWorkbench.expandWithTerminals', () =>
      expandWhere((w) => terminalsFor(w, provider.worktrees).length > 0),
    ),
    vscode.commands.registerCommand('petrWorkbench.expandWithMetro', () =>
      expandWhere((w) => provider.metros.some((m) => ownerOf(m.cwd, provider.worktrees)?.dir === w.dir)),
    ),
    tree.onDidExpandElement((e) => e.element.kind === 'worktree' && provider.expanded.add(e.element.worktree.dir)),
    tree.onDidCollapseElement((e) => e.element.kind === 'worktree' && provider.expanded.delete(e.element.worktree.dir)),
    vscode.commands.registerCommand('petrWorkbench.openCode', (node) =>
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktree.dir), { forceNewWindow: true }),
    ),
    vscode.commands.registerCommand('petrWorkbench.newTerminal', newTerminal),
    vscode.commands.registerCommand('petrWorkbench.openTicket', (node) => vscode.env.openExternal(vscode.Uri.parse(ticketUrl(node.worktree)))),
    vscode.commands.registerCommand('petrWorkbench.focusDevice', (node) => focusDevice(node.metro.devices[0])),
    vscode.commands.registerCommand('petrWorkbench.showTerminal', (node) => node.terminal.show()),
    vscode.commands.registerCommand('petrWorkbench.openSession', (node) => openSession(node.session, requestFile)),
    vscode.commands.registerCommand('petrWorkbench.resumeSessionInTerminal', (node) => {
      const t = vscode.window.createTerminal({ name: node.session.title, cwd: node.session.originDir })
      t.sendText(`claude --resume ${node.session.id}`)
      t.show()
    }),
    vscode.window.onDidOpenTerminal(() => provider.refresh()),
    vscode.window.onDidCloseTerminal(() => provider.refresh()),
    vscode.window.onDidChangeTerminalShellIntegration(() => provider.refresh()),
  )

  // Metro servers start and stop outside this window. Poll them and re-render only when something
  // changed, so expanded session lists are not re-read every tick.
  const poll = setInterval(async () => {
    const metros = await listMetros()
    if (JSON.stringify(metros) !== JSON.stringify(provider.metros)) {
      provider.metros = metros
      provider.refresh()
    }
  }, 5000)
  context.subscriptions.push({ dispose: () => clearInterval(poll) })

  // Refresh when Claude writes a session file. Debounced because a live session writes constantly.
  if (fs.existsSync(CLAUDE_PROJECTS)) {
    let timer
    const watcher = fs.watch(CLAUDE_PROJECTS, { recursive: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(() => provider.refresh(), 2000)
    })
    context.subscriptions.push({ dispose: () => watcher.close() })
  }
}

module.exports = { activate }
