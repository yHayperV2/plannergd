const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');

function createWindow () {
  // Cria a janela do navegador.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false, // Só mostra a tela depois de carregar para evitar fundo branco
    autoHideMenuBar: true, // Oculta a barra de Arquivo, Editar, etc.
    webPreferences: {
      nodeIntegration: true, // Mantém compatibilidade máxima de recursos
      contextIsolation: false
    }
  });

  // Remove o menu padrao do Electron caso ache confuso (Opcional)
  Menu.setApplicationMenu(null);

  // Carrega o arquivo index.html do app Web
  mainWindow.loadFile('www/index.html');

  // Mostra de forma elegante apenas quando estiver tudo desenhado
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

// Este método será chamado quando o Electron terminar
// sua inicialização e estiver pronto para criar janelas de navegador.
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    // No macOS, é comum recriar uma janela no aplicativo quando o
    // ícone do dock é clicado e não há outras janelas abertas.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Sair quando todas as janelas forem fechadas, exceto no macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});