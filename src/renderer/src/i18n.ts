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

    // Setup overlay
    setup_sub:      'First launch: downloading yt-dlp engine (~10 MB from GitHub)',
    setup_init:     'Initialize Engine',
    setup_retry:    '↺ Retry Download',
    setup_loading:  'Downloading yt-dlp... may take a minute',
    setup_manual:   'Or install yt-dlp manually and restart:',

    // Fetch error
    fetch_failed:  'Failed to fetch info',
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

    // Setup overlay
    setup_sub:      'Первый запуск: скачивание движка yt-dlp (~10 МБ с GitHub)',
    setup_init:     'Инициализировать',
    setup_retry:    '↺ Повторить',
    setup_loading:  'Скачивание yt-dlp... может занять минуту',
    setup_manual:   'Или установите yt-dlp вручную и перезапустите:',

    // Fetch error
    fetch_failed:  'Не удалось получить информацию',
  }
} as const

export type TranslationKey = keyof typeof translations.en
export type Translations = typeof translations.en
