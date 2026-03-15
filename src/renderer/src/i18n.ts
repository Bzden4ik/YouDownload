export type Lang = 'en' | 'ru'

export const translations = {
  en: {
    // Sidebar
    nav_download:  'Download',
    nav_history:   'History',
    nav_settings:  'Settings',
    status_ready:  'System Ready',

    // URL section
    paste_url:     'PASTE URL',
    url_hint:      'YouTube · YouTube Music · Shorts · Playlists · 1000+ sites',
    btn_paste:     'Paste',
    btn_fetch:     'Fetch',

    // Format selector
    fmt_video:     'Video',
    fmt_audio:     'Audio',
    btn_download_video: 'Download Video',
    btn_download_audio: 'Download Audio',

    // Video info
    views:         'views',

    // Download statuses
    st_pending:     'Pending',
    st_downloading: 'Downloading',
    st_processing:  'Processing',
    st_complete:    'Complete',
    st_error:       'Failed',
    st_cancelled:   'Cancelled',

    // Download card
    eta:           'ETA',

    // Queue
    lbl_downloads: 'DOWNLOADS',
    lbl_active:    'active',

    // History
    hist_title:    'History',
    hist_items:    'items',
    hist_empty:    'No history yet',
    hist_clear:    'Clear',

    // Settings
    set_title:         'Settings',
    set_folder_label:  'Download Folder',
    set_folder_browse: 'Browse',
    set_concurrent:    'Concurrent Downloads',
    set_save:          'Save Settings',
    set_theme:         'Theme',
    theme_fleet:       'FleetWatch',
    theme_apathy:      'Vulnerable Apathy',
    set_cookies:       'Cookies (if YouTube blocks downloads)',
    set_cookies_hint:  'Off works for most videos. Chrome not listed — broken in Chrome 127+. Use Edge or Firefox.',
    set_update_ytdlp:  'Update yt-dlp engine',
    set_updating:      'Updating...',
    set_updated:       'Up to date ✓',
    set_update_failed: 'Update failed',
    set_extract_cookies:      'YouTube Account Cookies',
    set_extract_cookies_hint: 'Opens YouTube in a built-in window. Sign in once — next time the session is already saved, just close the window.',
    set_extract_no_browser:   'Select a browser above first (not Off)',
    set_extracting:           'Waiting for you to close the window...',
    set_extract_ok:           'Cookies saved ✓',
    set_extract_fail:         'No cookies found',

    // Setup overlay
    setup_sub:      'First launch: downloading yt-dlp engine (~10 MB from GitHub)',
    setup_init:     'Initialize Engine',
    setup_retry:    '↺ Retry Download',
    setup_loading:  'Downloading yt-dlp... may take a minute',
    setup_manual:   'Or install yt-dlp manually and restart:',

    // Fetch error
    fetch_failed:  'Failed to fetch info',
    err_cookie_hint: 'Cookie issue?',
    playlist_detected: 'Playlist detected',
    playlist_count: 'videos',
    playlist_loading: 'Loading playlist...',
    playlist_download_all: 'Download all',
    playlist_download_one: 'This video only',
  },

  ru: {
    // Sidebar
    nav_download:  'Загрузка',
    nav_history:   'История',
    nav_settings:  'Настройки',
    status_ready:  'Система готова',

    // URL section
    paste_url:     'ВСТАВИТЬ ССЫЛКУ',
    url_hint:      'YouTube · YouTube Music · Shorts · Плейлисты · 1000+ сайтов',
    btn_paste:     'Вставить',
    btn_fetch:     'Найти',

    // Format selector
    fmt_video:     'Видео',
    fmt_audio:     'Аудио',
    btn_download_video: 'Скачать видео',
    btn_download_audio: 'Скачать аудио',

    // Video info
    views:         'просм.',

    // Download statuses
    st_pending:     'Ожидание',
    st_downloading: 'Загрузка',
    st_processing:  'Обработка',
    st_complete:    'Готово',
    st_error:       'Ошибка',
    st_cancelled:   'Отменено',

    // Download card
    eta:           'Осталось',

    // Queue
    lbl_downloads: 'ЗАГРУЗКИ',
    lbl_active:    'активно',

    // History
    hist_title:    'История',
    hist_items:    'файлов',
    hist_empty:    'История пуста',
    hist_clear:    'Очистить',

    // Settings
    set_title:         'Настройки',
    set_folder_label:  'Папка для загрузок',
    set_folder_browse: 'Выбрать',
    set_concurrent:    'Параллельных загрузок',
    set_save:          'Сохранить',
    set_theme:         'Тема',
    theme_fleet:       'FleetWatch',
    theme_apathy:      'Vulnerable Apathy',
    set_cookies:       'Куки (если YouTube блокирует)',
    set_cookies_hint:  'Off работает для большинства видео. Chrome не поддерживается (сломан в Chrome 127+). Используй Edge или Firefox.',
    set_update_ytdlp:  'Обновить движок yt-dlp',
    set_updating:      'Обновляю...',
    set_updated:       'Актуально ✓',
    set_update_failed: 'Ошибка обновления',
    set_extract_cookies:      'Куки аккаунта YouTube',
    set_extract_cookies_hint: 'Открывает YouTube во встроенном окне. Войдите один раз — в следующий раз сессия уже сохранена, просто закройте окно.',
    set_extract_no_browser:   'Сначала выберите браузер выше (не Off)',
    set_extracting:           'Ожидаю закрытия окна...',
    set_extract_ok:           'Куки сохранены ✓',
    set_extract_fail:         'Куки не найдены',

    // Setup overlay
    setup_sub:      'Первый запуск: скачивание движка yt-dlp (~10 МБ с GitHub)',
    setup_init:     'Инициализировать',
    setup_retry:    '↺ Повторить',
    setup_loading:  'Скачивание yt-dlp... может занять минуту',
    setup_manual:   'Или установите yt-dlp вручную и перезапустите:',

    // Fetch error
    fetch_failed:  'Не удалось получить информацию',
    err_cookie_hint: 'Проблема с cookies?',
    playlist_detected: 'Обнаружен плейлист',
    playlist_count: 'видео',
    playlist_loading: 'Загружаю плейлист...',
    playlist_download_all: 'Скачать все',
    playlist_download_one: 'Только это видео',
  }
} as const

export type TranslationKey = keyof typeof translations.en
export type Translations = typeof translations.en
