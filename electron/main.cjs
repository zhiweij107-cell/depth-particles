const { app, BrowserWindow, shell } = require('electron')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

function distRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'dist')
  }
  return path.join(__dirname, '..', 'dist')
}

function createStaticServer(root) {
  const rootResolved = path.resolve(root)
  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      let pathname = decodeURIComponent(url.pathname)
      if (pathname === '/') pathname = '/index.html'
      // Prevent path traversal
      const filePath = path.resolve(rootResolved, '.' + pathname.replace(/^\/+/, '/'))
      if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const ext = path.extname(filePath).toLowerCase()
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      })
      fs.createReadStream(filePath).pipe(res)
    } catch (err) {
      res.writeHead(500)
      res.end(String(err))
    }
  })
}

async function listenLocal(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server.address().port
}

let mainWindow = null
let server = null

async function createWindow() {
  const root = distRoot()
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    const { dialog } = require('electron')
    dialog.showErrorBox(
      '缺少构建产物',
      `未找到界面文件：\n${root}\n\n请先运行 npm run build，再启动应用。`,
    )
    app.quit()
    return
  }

  server = createStaticServer(root)
  const port = await listenLocal(server)
  const url = `http://127.0.0.1:${port}/`

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: '深度粒子 · Depth Particles',
    backgroundColor: '#f5f5f3',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })

  await mainWindow.loadURL(url)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (server) {
    try {
      server.close()
    } catch {
      /* ignore */
    }
    server = null
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
