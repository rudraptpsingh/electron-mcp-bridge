'use strict'

const { EventEmitter } = require('node:events')

function createMockApp(overrides = {}) {
  const app = new EventEmitter()
  app.getName = () => 'ShotSelect'
  app.getVersion = () => '1.18.21'
  app.getLocale = () => 'en-US'
  app.isPackaged = false
  return Object.assign(app, overrides)
}

function createMockIpcMain(handlers = new Map()) {
  return {
    _invokeHandlers: handlers,
    eventNames: () => ['app:ready'],
  }
}

function createMockBrowserWindow(windows = []) {
  if (windows.length === 0) {
    windows.push({
      id: 1,
      getTitle: () => 'ShotSelect - Main Window',
      getBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      isFocused: () => true,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: {
        getURL: () => 'app://index.html#/grid',
        isLoading: () => false,
        isCrashed: () => false,
        executeJavaScript: async () => ({}),
        capturePage: async () => ({ toPNG: () => Buffer.from('mock-png') }),
      },
    })
  }

  return {
    getAllWindows: () => windows,
  }
}

module.exports = {
  createMockApp,
  createMockIpcMain,
  createMockBrowserWindow,
}
