const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('yoko', {
  appAuthStatus: () => ipcRenderer.invoke('app-auth-status'),
  appAuthLogin: payload => ipcRenderer.invoke('app-auth-login', payload || {}),
  appAuthLogout: () => ipcRenderer.invoke('app-auth-logout'),
  officialApiAuthStatus: () => ipcRenderer.invoke('official-api-auth-status'),
  officialApiLogin: payload => ipcRenderer.invoke('official-api-login', payload || {}),
  officialApiLogout: () => ipcRenderer.invoke('official-api-logout'),
  getState: () => ipcRenderer.invoke('get-state'),
  openChatHistoryWindow: () => ipcRenderer.invoke('open-chat-history-window'),
  openSpeechLibraryWindow: () => ipcRenderer.invoke('open-speech-library-window'),
  getSpeechLibrary: () => ipcRenderer.invoke('speech-library-get'),
  saveSpeechLibrary: library => ipcRenderer.invoke('speech-library-save', library || {}),
  getSpeechLibraryTarget: () => ipcRenderer.invoke('speech-library-target'),
  sendSpeechLibraryMessage: payload => ipcRenderer.invoke('speech-library-send', payload || {}),
  getChatgptWorkbenchState: () => ipcRenderer.invoke('chatgpt-workbench-state'),
  setChatgptCustomerMode: mode => ipcRenderer.invoke('chatgpt-customer-mode-set', mode || ''),
  setChatgptDailyFlowCurrentDay: day => ipcRenderer.invoke('chatgpt-daily-flow-set-current-day', Number(day || 0)),
  toggleChatgptWorkbench: visible => ipcRenderer.invoke('chatgpt-workbench-toggle', visible),
  bindCurrentChatgptConversation: () => ipcRenderer.invoke('chatgpt-workbench-bind-current'),
  getWsExistingChatgptBindings: () => ipcRenderer.invoke('chatgpt-ws-existing-bindings'),
  linkWsExistingChatgptBinding: key => ipcRenderer.invoke('chatgpt-ws-link-existing', key),
  unbindCurrentChatgptConversation: () => ipcRenderer.invoke('chatgpt-workbench-unbind-current'),
  syncChatgptWorkbenchTarget: () => ipcRenderer.invoke('chatgpt-workbench-sync-target'),
  showChatgptWorkbenchForCustomer: () => ipcRenderer.invoke('chatgpt-workbench-show-for-customer'),
  stageCustomerTurnToChatgpt: () => ipcRenderer.invoke('chatgpt-workbench-stage-customer-turn'),
  getChatgptReplySettings: () => ipcRenderer.invoke('chatgpt-reply-settings-get'),
  saveChatgptReplySettings: payload => ipcRenderer.invoke('chatgpt-reply-settings-save', payload || {}),
  getChatgptPersona: () => ipcRenderer.invoke('chatgpt-persona-get'),
  saveChatgptPersona: value => ipcRenderer.invoke('chatgpt-persona-save', value || ''),
  sendChatgptPersona: () => ipcRenderer.invoke('chatgpt-persona-send'),
  reloadChatgptWorkbench: () => ipcRenderer.invoke('chatgpt-workbench-reload'),
  getAutomationSettings: () => ipcRenderer.invoke('automation-settings-get'),
  saveAutomationSettings: payload => ipcRenderer.invoke('automation-settings-save', payload || {}),
  getAutomationDiagnostics: limit => ipcRenderer.invoke('automation-diagnostics-tail', limit || 120),
  getRuntimePerformance: () => ipcRenderer.invoke('get-runtime-performance'),
  getAccountHealthCenter: () => ipcRenderer.invoke('get-account-health-center'),
  createOperationsBackup: workspace => ipcRenderer.invoke('create-operations-backup', workspace || {}),
  createAutoOperationsBackup: workspace => ipcRenderer.invoke('create-auto-operations-backup', workspace || {}),
  restoreOperationsBackup: () => ipcRenderer.invoke('restore-operations-backup'),
  getCustomerNumberVaultStats: () => ipcRenderer.invoke('customer-number-vault-stats'),
  listCustomerNumberVault: filter => ipcRenderer.invoke('customer-number-vault-list', filter || {}),
  upsertCustomerNumber: payload => ipcRenderer.invoke('customer-number-vault-upsert', payload || {}),
  importCustomerNumberRows: rows => ipcRenderer.invoke('customer-number-vault-import-rows', rows || []),
  markCustomerGroupDeleted: payload => ipcRenderer.invoke('customer-number-vault-mark-group-deleted', payload || {}),
  exportCustomerNumberCsv: () => ipcRenderer.invoke('customer-number-vault-export-csv'),
  createDiagnosticPack: () => ipcRenderer.invoke('create-diagnostic-pack'),
  getLongRunStability: () => ipcRenderer.invoke('stability-long-run-get'),
  runStabilityStressTest: options => ipcRenderer.invoke('stability-stress-run', options || {}),
  exportLongRunStabilityReport: () => ipcRenderer.invoke('stability-long-run-export'),
  getAppCenterState: () => ipcRenderer.invoke('get-app-center-state'),
  getOperationsDashboard: () => ipcRenderer.invoke('get-operations-dashboard'),
  getTeamSyncState: () => ipcRenderer.invoke('team-sync-get'),
  generateTeamSyncCredentials: () => ipcRenderer.invoke('team-sync-generate-credentials'),
  saveTeamSyncSettings: payload => ipcRenderer.invoke('team-sync-save', payload || {}),
  detectTeamCloudflared: explicitPath => ipcRenderer.invoke('team-sync-cloudflare-detect', explicitPath || ''),
  openTeamCloudflareDownload: () => ipcRenderer.invoke('team-sync-cloudflare-open-download'),
  testTeamCloudflarePublicUrl: publicUrl => ipcRenderer.invoke('team-sync-cloudflare-test-public', publicUrl || ''),
  syncTeamNow: () => ipcRenderer.invoke('team-sync-now'),
  acceptTeamHandoffTask: taskId => ipcRenderer.invoke('team-sync-task-accept', taskId || ''),
  bindTeamHandoffCurrentLine: payload => ipcRenderer.invoke('team-sync-bind-current-line', payload || {}),
  installAppCenterPlatform: platform => ipcRenderer.invoke('install-app-center-platform', platform),
  removeAppCenterPlatform: platform => ipcRenderer.invoke('remove-app-center-platform', platform),
  addAppCenterAccount: (platform, name = '') => ipcRenderer.invoke('add-app-center-account', platform, name),
  renameAppCenterAccount: (accountId, name) => ipcRenderer.invoke('rename-app-center-account', accountId, name),
  reorderAppCenterAccounts: (platform, orderedIds) => ipcRenderer.invoke('reorder-app-center-accounts', platform, orderedIds),
  updateAppCenterAccountRemark: (accountId, remark) => ipcRenderer.invoke('update-app-center-account-remark', accountId, remark),
  updateAppCenterAccountPhone: (accountId, phoneNumber) => ipcRenderer.invoke('update-app-center-account-phone', accountId, phoneNumber),
  restartAppCenterAccount: accountId => ipcRenderer.invoke('restart-app-center-account', accountId),
  openAllAppCenterAccounts: platform => ipcRenderer.invoke('open-all-app-center-accounts', platform),
  closeAllAppCenterAccounts: platform => ipcRenderer.invoke('close-all-app-center-accounts', platform),
  restartAllAppCenterAccounts: platform => ipcRenderer.invoke('restart-all-app-center-accounts', platform),
  setExternalAccountSidebarCollapsed: collapsed => ipcRenderer.invoke('set-external-account-sidebar-collapsed', !!collapsed),
  openAppCenterAccount: accountId => ipcRenderer.invoke('open-app-center-account', accountId),
  closeAppCenterAccount: accountId => ipcRenderer.invoke('close-app-center-account', accountId),
  deleteAppCenterAccount: accountId => ipcRenderer.invoke('delete-app-center-account', accountId),
  setShellSurface: (surface, accountId = '') => ipcRenderer.invoke('set-shell-surface', surface, accountId),
  setNativeViewsVisible: visible => ipcRenderer.invoke('set-native-views-visible', !!visible),
  setNativeApiMenuStatus: message => ipcRenderer.send('native-api-menu-status', String(message || '')),
  reloadAppCenterAccount: accountId => ipcRenderer.invoke('reload-app-center-account', accountId),
  goBackAppCenterAccount: accountId => ipcRenderer.invoke('go-back-app-center-account', accountId),
  updateAppCenterAccountProxy: (accountId, proxy) => ipcRenderer.invoke('update-app-center-account-proxy', accountId, proxy || {}),
  testAppCenterProxy: proxy => ipcRenderer.invoke('test-app-center-proxy', proxy || {}),
  testAppCenterAccountNetwork: accountId => ipcRenderer.invoke('test-app-center-account-network', accountId),
  getPlatformAggregate: platform => ipcRenderer.invoke('get-platform-aggregate', platform),
  refreshPlatformAggregate: platform => ipcRenderer.invoke('refresh-platform-aggregate', platform),
  setExternalWorkspaceMode: (platform, mode) => ipcRenderer.invoke('set-external-workspace-mode', platform, mode),
  openPlatformAggregateConversation: payload => ipcRenderer.invoke('open-platform-aggregate-conversation', payload || {}),
  getCurrentPlatformChatCrm: (platform, accountId = '') => ipcRenderer.invoke('get-current-platform-chat-crm', { platform, accountId }),
  traceConversionDiagnostic: payload => ipcRenderer.send('conversion-diagnostic-ui', payload || {}),
  runConversionDiagnostics: (platform, accountId = '') => ipcRenderer.invoke('run-conversion-diagnostics', { platform, accountId }),
  getPlatformCrmContact: payload => ipcRenderer.invoke('platform-crm-contact', payload || {}),
  savePlatformCrmContact: payload => ipcRenderer.invoke('platform-crm-save-contact', payload || {}),
  setLineViewVisible: visible => ipcRenderer.invoke('set-line-view-visible', !!visible),
  setWorkspaceMode: mode => ipcRenderer.invoke('set-workspace-mode', mode),
  setLayoutMetrics: metrics => ipcRenderer.invoke('set-layout-metrics', metrics || {}),
  setAccountSidebarCollapsed: collapsed => ipcRenderer.invoke('set-account-sidebar-collapsed', !!collapsed),
  chooseLineExtension: () => ipcRenderer.invoke('choose-line-extension'),
  importLineExtension: () => ipcRenderer.invoke('import-line-extension'),
  autoDetectLineExtension: () => ipcRenderer.invoke('auto-detect-line-extension'),
  saveSettings: settings => ipcRenderer.invoke('save-settings', settings),
  testAiProvider: payload => ipcRenderer.invoke('test-ai-provider', payload),
  getGptTranslationCacheStats: () => ipcRenderer.invoke('gpt-translation-cache-stats'),
  getOllamaManagerStatus: () => ipcRenderer.invoke('get-ollama-manager-status'),
  detectOllamaRuntime: () => ipcRenderer.invoke('detect-ollama-runtime'),
  installOllamaRuntime: options => ipcRenderer.invoke('install-ollama-runtime', options || {}),
  installOllamaModel: model => ipcRenderer.invoke('install-ollama-model', model),
  deleteOllamaModel: model => ipcRenderer.invoke('delete-ollama-model', model),
  selectOllamaModel: model => ipcRenderer.invoke('select-ollama-model', model),

  addAccount: account => ipcRenderer.invoke('add-account', account),
  updateAccount: account => ipcRenderer.invoke('update-account', account),
  updateAccountRemark: (accountId, remark) => ipcRenderer.invoke('update-account-remark', accountId, remark),
  updateAccountDisplayName: (accountId, displayName) => ipcRenderer.invoke('update-account-display-name', accountId, displayName),
  reorderAccounts: orderedIds => ipcRenderer.invoke('reorder-accounts', orderedIds),
  openAllAccountWindows: () => ipcRenderer.invoke('open-all-account-windows'),
  closeAllAccountWindows: () => ipcRenderer.invoke('close-all-account-windows'),
  restartAllAccountWindows: () => ipcRenderer.invoke('restart-all-account-windows'),
  openAccountWindow: accountId => ipcRenderer.invoke('open-account-window', accountId),
  closeAccountWindow: accountId => ipcRenderer.invoke('close-account-window', accountId),
  deleteAccount: accountId => ipcRenderer.invoke('delete-account', accountId),
  selectAccount: accountId => ipcRenderer.invoke('select-account', accountId),
  reloadAccount: () => ipcRenderer.invoke('reload-account'),
  accountDiagnostics: accountId => ipcRenderer.invoke('account-diagnostics', accountId),
  flushAccount: accountId => ipcRenderer.invoke('flush-account', accountId),
  refreshAccountAvatar: (accountId, options = {}) => ipcRenderer.invoke('refresh-account-avatar', accountId, options),
  refreshAggregateAvatars: (options = {}) => ipcRenderer.invoke('refresh-aggregate-avatars', options),

  getAggregateInbox: () => ipcRenderer.invoke('get-aggregate-inbox'),
  refreshAggregateInbox: () => ipcRenderer.invoke('refresh-aggregate-inbox'),
  prewarmAggregateConversation: (accountId, chatId) => ipcRenderer.invoke('prewarm-aggregate-conversation', accountId, chatId),
  openAggregateConversation: (accountId, chatId) => ipcRenderer.invoke('open-aggregate-conversation', accountId, chatId),
  focusAggregateComposer: accountId => ipcRenderer.invoke('focus-aggregate-composer', accountId),
  openLineProfileCard: (accountId, chatId) => ipcRenderer.invoke('open-line-profile-card', accountId, chatId),
  aggregateTranslate: (accountId, chatId, text, source = 'zh', target = 'ja') =>
    ipcRenderer.invoke('aggregate-translate', { accountId, chatId, text, source, target }),
  aggregateTranslateLatest: (accountId, chatId, target = 'zh') =>
    ipcRenderer.invoke('aggregate-translate-latest', { accountId, chatId, target }),
  aggregateSendMessage: (accountId, chatId, text, originalText = '') =>
    ipcRenderer.invoke('aggregate-send-message', { accountId, chatId, text, originalText }),

  translate: payload => ipcRenderer.invoke('translate', payload),

  getCurrentChatCrm: () => ipcRenderer.invoke('crm-current-chat'),
  getConversationContact: contact => ipcRenderer.invoke('crm-conversation-contact', contact),
  saveCurrentContact: contact => ipcRenderer.invoke('crm-save-contact', contact),
  getLineCurrentChatInfo: () => ipcRenderer.invoke('line-current-chat-info'),

  testAccountNetwork: accountId => ipcRenderer.invoke('test-account-network', accountId),
  testProxyConfig: proxy => ipcRenderer.invoke('test-proxy-config', proxy),
  testActiveNetwork: () => ipcRenderer.invoke('test-active-network'),

  getLineSelection: () => ipcRenderer.invoke('line-selected-text'),
  getLineClickedText: () => ipcRenderer.invoke('line-clicked-text'),
  getLineRecentMessages: limit => ipcRenderer.invoke('line-recent-messages', limit),
  getLineRecentMessagesDetailed: limit => ipcRenderer.invoke('line-recent-messages-detailed', limit),
  generateAiReply: payload => ipcRenderer.invoke('ai-reply-generate', payload),
  getChatScriptAiHealth: () => ipcRenderer.invoke('chatscript-ai-health'),
  generateChatScriptAiReply: payload => ipcRenderer.invoke('chatscript-ai-generate', payload),
  markChatScriptAiSent: payload => ipcRenderer.invoke('chatscript-ai-mark-sent', payload),
  feedbackChatScriptAi: payload => ipcRenderer.invoke('chatscript-ai-feedback', payload),
  getLineInput: () => ipcRenderer.invoke('line-get-input'),
  setLineInput: text => ipcRenderer.invoke('line-set-input', text),
  sendLineCurrent: () => ipcRenderer.invoke('line-send-current'),

  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onSoftwareUpdateStatus: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('software-update-status', handler);
    return () => ipcRenderer.removeListener('software-update-status', handler);
  },

  onAccountStatus: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('account-status', handler);
    return () => ipcRenderer.removeListener('account-status', handler);
  },

  onTranslationStatus: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('translation-status', handler);
    return () => ipcRenderer.removeListener('translation-status', handler);
  },

  onOllamaManagerProgress: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('ollama-manager-progress', handler);
    return () => ipcRenderer.removeListener('ollama-manager-progress', handler);
  },

  onChatgptWorkbenchUpdated: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('chatgpt-workbench-updated', handler);
    return () => ipcRenderer.removeListener('chatgpt-workbench-updated', handler);
  },
  onAutomationGptStatus: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('automation-gpt-status', handler);
    return () => ipcRenderer.removeListener('automation-gpt-status', handler);
  },

  onAccountOverview: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('account-overview', handler);
    return () => ipcRenderer.removeListener('account-overview', handler);
  },

  onAggregateUpdated: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('aggregate-updated', handler);
    return () => ipcRenderer.removeListener('aggregate-updated', handler);
  },

  onCrmAutoExtracted: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('crm-auto-extracted', handler);
    return () => ipcRenderer.removeListener('crm-auto-extracted', handler);
  },

  onAggregateChatSwitch: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('aggregate-chat-switch', handler);
    return () => ipcRenderer.removeListener('aggregate-chat-switch', handler);
  },

  onAggregateKeyboardNav: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('aggregate-keyboard-nav', handler);
    return () => ipcRenderer.removeListener('aggregate-keyboard-nav', handler);
  },

  onAppCenterUpdated: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('app-center-updated', handler);
    return () => ipcRenderer.removeListener('app-center-updated', handler);
  },

  onAppCenterResourceWarning: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('app-center-resource-warning', handler);
    return () => ipcRenderer.removeListener('app-center-resource-warning', handler);
  },

  onFacebookWorkspaceBackFallback: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('facebook-workspace-back-fallback', handler);
    return () => ipcRenderer.removeListener('facebook-workspace-back-fallback', handler);
  },

  onExternalNativeChatSelected: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('external-native-chat-selected', handler);
    return () => ipcRenderer.removeListener('external-native-chat-selected', handler);
  },

  onPlatformAggregateUpdated: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('platform-aggregate-updated', handler);
    return () => ipcRenderer.removeListener('platform-aggregate-updated', handler);
  },

  onTeamSyncUpdated: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('team-sync-updated', handler);
    return () => ipcRenderer.removeListener('team-sync-updated', handler);
  },
  onOfficialApiAuthUpdated: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('official-api-auth-updated', handler);
    return () => ipcRenderer.removeListener('official-api-auth-updated', handler);
  },
  onAppAuthUpdated: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('app-auth-updated', handler);
    return () => ipcRenderer.removeListener('app-auth-updated', handler);
  },
  onCustomerNumberVaultUpdated: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('customer-number-vault-updated', handler);
    return () => ipcRenderer.removeListener('customer-number-vault-updated', handler);
  },

  onStartupError: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('startup-error', handler);
    return () => ipcRenderer.removeListener('startup-error', handler);
  }
});
