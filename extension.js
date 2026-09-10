const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects')

// Node shapes: { kind: 'worktree'|'claude'|'terminals'|'code'|'session'|'terminal'|'newTerminal', id, worktree, ... }

function repoRoot() {
  const configured = vscode.workspace.getConfiguration('petrWorkbench').get('repoRoot')
  return configured || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

function listWorktrees(root) {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })
  return out
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const dir = block.match(/^worktree (.+)$/m)?.[1]
      const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]
      const isRoot = path.resolve(dir) === path.resolve(root)
      return { dir, branch, name: isRoot ? 'Root' : path.basename(dir), isRoot }
    })
    .sort((a, b) => (a.isRoot ? -1 : b.isRoot ? 1 : a.name.localeCompare(b.name)))
}

// Claude stores sessions in a folder named after the cwd with every "/" and "." turned into "-".
function claudeProjectDir(dir) {
  return path.join(CLAUDE_PROJECTS, dir.replace(/[/.]/g, '-'))
}

function sessionTitle(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(256 * 1024)
  const n = fs.readSync(fd, buf, 0, buf.length, 0)
  fs.closeSync(fd)
  const lines = buf.toString('utf8', 0, n).split('\n')
  let title
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type === 'custom-title' && entry.customTitle) return entry.customTitle
    if (entry.type === 'summary' && entry.summary && !title) title = entry.summary
    if (entry.type === 'user' && !entry.isSidechain && !title) {
      const content = entry.message?.content
      const texts = typeof content === 'string' ? [content] : (content ?? []).filter((c) => c.type === 'text').map((c) => c.text)
      const clean = texts
        .map((t) => t.replace(/<(\w[\w-]*)>[\s\S]*?<\/\1>/g, '').trim())
        .find(Boolean)
      if (clean) title = clean.split('\n')[0].slice(0, 80)
    }
  }
  return title
}

function listSessions(dir) {
  const projectDir = claudeProjectDir(dir)
  if (!fs.existsSync(projectDir)) return []
  return fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const file = path.join(projectDir, f)
      return { id: path.basename(f, '.jsonl'), file, mtime: fs.statSync(file).mtimeMs, title: sessionTitle(file) }
    })
    .filter((s) => s.title)
    .sort((a, b) => b.mtime - a.mtime)
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
    const owner = worktrees
      .filter((w) => cwd === w.dir || cwd.startsWith(w.dir + path.sep))
      .sort((a, b) => b.dir.length - a.dir.length)[0]
    return owner?.dir === worktree.dir
  })
}

class Provider {
  constructor() {
    this.emitter = new vscode.EventEmitter()
    this.onDidChangeTreeData = this.emitter.event
    this.worktrees = []
  }

  refresh() {
    this.emitter.fire()
  }

  getChildren(node) {
    if (!node) {
      const root = repoRoot()
      this.worktrees = root ? listWorktrees(root) : []
      return this.worktrees.map((w) => ({ kind: 'worktree', id: w.dir, worktree: w }))
    }
    const w = node.worktree
    switch (node.kind) {
      case 'worktree':
        return ['claude', 'terminals', 'code'].map((kind) => ({ kind, id: `${w.dir}:${kind}`, worktree: w, parent: node }))
      case 'claude':
        return listSessions(w.dir).map((s) => ({ kind: 'session', id: `${w.dir}:session:${s.id}`, worktree: w, session: s, parent: node }))
      case 'terminals':
        return [
          { kind: 'newTerminal', id: `${w.dir}:newTerminal`, worktree: w, parent: node },
          ...terminalsFor(w, this.worktrees).map((t) => ({ kind: 'terminal', id: `${w.dir}:terminal:${t.name}:${t.processId}`, worktree: w, terminal: t, parent: node })),
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
  const provider = new Provider()
  const tree = vscode.window.createTreeView('petrWorkbench.tree', { treeDataProvider: provider })

  const expand = (node) => tree.reveal(node, { expand: 3 })
  const newTerminal = (node) => vscode.window.createTerminal({ name: node.worktree.name, cwd: node.worktree.dir }).show()

  context.subscriptions.push(
    tree,
    vscode.commands.registerCommand('petrWorkbench.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('petrWorkbench.expandAll', async () => {
      for (const node of provider.getChildren()) await expand(node)
    }),
    vscode.commands.registerCommand('petrWorkbench.expandWorktree', expand),
    vscode.commands.registerCommand('petrWorkbench.openCode', (node) =>
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktree.dir), { forceNewWindow: true }),
    ),
    vscode.commands.registerCommand('petrWorkbench.newTerminal', newTerminal),
    vscode.commands.registerCommand('petrWorkbench.showTerminal', (node) => node.terminal.show()),
    vscode.commands.registerCommand('petrWorkbench.openSession', (node) =>
      vscode.commands.executeCommand('claude-vscode.editor.open', node.session.id),
    ),
    vscode.commands.registerCommand('petrWorkbench.resumeSessionInTerminal', (node) => {
      const t = vscode.window.createTerminal({ name: node.session.title, cwd: node.worktree.dir })
      t.sendText(`claude --resume ${node.session.id}`)
      t.show()
    }),
    vscode.window.onDidOpenTerminal(() => provider.refresh()),
    vscode.window.onDidCloseTerminal(() => provider.refresh()),
    vscode.window.onDidChangeTerminalShellIntegration(() => provider.refresh()),
  )

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
