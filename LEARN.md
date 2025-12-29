# Learn - Messenger Desktop Client/Wrapper

A quick guide to understanding and working with Messenger Desktop (Unofficial).

---

## 🎯 What is This?

Messenger Desktop is an **unofficial desktop client** for Facebook Messenger built with Electron. It wraps messenger.com in a native desktop application with custom features like:

- 🎨 6 premium themes
- 🔔 System tray integration
- 📞 Enhanced video calls with screen sharing
- 🔒 Secure, sandboxed architecture
- 🚀 First-time login flow

---

## 🏗️ How It Works

### Architecture Overview

```
┌─────────────────────────────────────┐
│  Main Process (Node.js)             │
│  - Window management                │
│  - System tray                      │
│  - IPC handlers                     │
│  - Menu & shortcuts                 │
└──────────────┬──────────────────────┘
               │
               ├─► BrowserView (messenger.com)
               │   - Sandboxed web content
               │   - Has preload script
               │
               └─► Custom Title Bar (HTML)
                   - Themes
                   - Window controls
                   - Settings
```

### Key Components

1. **Main Process** (`src/main/main.ts`)
   - Entry point of the application
   - Creates windows and BrowserViews
   - Handles all Node.js operations

2. **Preload Scripts** (`src/preload/`)
   - Bridge between web content and main process
   - Exposes limited API via contextBridge
   - Security boundary

3. **Renderer** (`src/renderer/`)
   - Custom title bar HTML/CSS/JS
   - Theme system
   - UI controls

4. **Shared** (`src/shared/`)
   - TypeScript types
   - Constants
   - IPC channel definitions

---

## 🔐 Security Model

### Trust Boundaries

```
Trusted:     Main Process ← Node.js access
Semi-Trusted: Preload Scripts ← Limited APIs
Untrusted:    BrowserView ← messenger.com (fully sandboxed)
```

### Security Features

- ✅ Context isolation enabled
- ✅ Sandbox enabled for web content
- ✅ No Node.js in renderer
- ✅ Input validation on all IPC
- ✅ Rate limiting
- ✅ Navigation control (only messenger.com allowed)

---

## 📂 Project Structure

```
src/
├── main/                  # Main process (Node.js)
│   ├── main.ts           # App entry point
│   ├── ipc-handlers.ts   # IPC message handlers
│   ├── tray.ts           # System tray
│   ├── menu.ts           # Application menu
│   └── window-manager.ts # Window state persistence
│
├── preload/              # Preload scripts (bridge)
│   ├── preload.ts        # Messenger view preload
│   └── titlebar-preload.ts # Title bar preload
│
├── renderer/             # Renderer process (UI)
│   └── titlebar.html     # Custom title bar
│
└── shared/               # Shared code
    └── types.ts          # TypeScript types & constants
```

---

## 🛠️ Common Tasks

### Run the App

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run app
npm start
```

### Make Changes

```bash
# Watch mode (auto-rebuild on changes)
npm run build:watch

# In another terminal, run the app
npm start
```

### Build Installer

```bash
# Windows
npm run dist:win

# Output: release/Messenger Desktop (Unofficial) Setup 1.0.0.exe
```

### Add a New Feature

1. **Update types** in `src/shared/types.ts`
2. **Add IPC handler** in `src/main/ipc-handlers.ts`
3. **Expose in preload** in `src/preload/titlebar-preload.ts`
4. **Use in renderer** in `src/renderer/titlebar.html`
5. **Test** with `npm start`

---

## 🎨 Theme System

### How Themes Work

1. User clicks palette icon in title bar
2. JavaScript updates localStorage
3. CSS is injected into messenger.com via `insertCSS()`
4. Theme persists across sessions

### Adding a New Theme

Edit `src/renderer/titlebar.html`:

```javascript
// Add to themes array
const themes = [
  { name: 'dark', label: 'Dark' },
  { name: 'your-theme', label: 'Your Theme' },
  // ...
];

// Add CSS in getThemeCSS()
case 'your-theme':
  return `
    :root {
      --bg-primary: #your-color;
      --text-primary: #your-text;
    }
  `;
```

---

## 🔌 IPC Communication

### Sending from Renderer to Main

```javascript
// In renderer (titlebar.html)
window.electronAPI.setMinimizeToTray(true);

// In preload (titlebar-preload.ts)
setMinimizeToTray: (enabled: boolean) => {
  ipcRenderer.send('minimize-to-tray', enabled);
}

// In main (ipc-handlers.ts)
ipcMain.on('minimize-to-tray', (event, enabled) => {
  // Handle the message
});
```

### Sending from Main to Renderer

```javascript
// In main
mainWindow.webContents.send('theme:changed', { theme: 'dark' });

// In preload
ipcRenderer.on('theme:changed', (event, data) => {
  // Handle the message
});
```

---

## 🐛 Debugging

### Open DevTools

**During Development:**
- Press `Ctrl+Shift+I` or `F12`

**In Code:**
```javascript
mainWindow.webContents.openDevTools();
```

### View Console Logs

- **Main process:** Terminal where you ran `npm start`
- **Renderer:** DevTools Console (F12)
- **BrowserView:** Right-click → Inspect

### Common Issues

**App won't start:**
```bash
npm run clean
npm install
npm run build
npm start
```

**TypeScript errors:**
```bash
npm run typecheck
```

**Themes not working:**
- Check browser console for CSS errors
- Verify theme CSS is being injected

---

## 📚 Key Technologies

- **Electron 38** - Desktop app framework
- **TypeScript 5** - Type-safe JavaScript
- **electron-builder** - Packaging & installers
- **electron-store** - Persistent config storage
- **sharp** - Image processing (icon generation)

---

## 📖 Useful Resources

### Documentation
- [Electron Docs](https://www.electronjs.org/docs/latest)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [electron-builder](https://www.electron.build/)

### Security
- [Electron Security Checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)

### Code Examples
- See `src/main/main.ts` - Window creation & BrowserView
- See `src/main/ipc-handlers.ts` - IPC patterns
- See `src/preload/titlebar-preload.ts` - contextBridge usage

---

## 🚀 Next Steps

1. **Explore the code** - Start with `src/main/main.ts`
2. **Make a small change** - Try adding a console.log
3. **Add a feature** - Maybe a new keyboard shortcut?
4. **Read Electron docs** - Learn about security best practices
5. **Contribute** - Open a PR with your improvements!

---

## ❓ Quick Reference

### File Locations

- **App Data:** `%APPDATA%/messenger-desktop-unofficial/`
- **Config:** `%APPDATA%/messenger-desktop-unofficial/config.json`
- **Window State:** `%APPDATA%/messenger-desktop-unofficial/window-state.json`
- **Session:** Handled by Electron (partition: `persist:messenger`)

### Commands

```bash
npm start          # Run app
npm run build      # Build TypeScript
npm run clean      # Clean dist/
npm run dist:win   # Build Windows installer
npm run typecheck  # Check types without building
```

**Happy coding!** 
