// UI languages, in switcher order. `locale` drives Intl number/date formatting;
// `font` is the Google Fonts family (css2 syntax) loaded when that language is active.
export const LANGUAGES = [
  { code: 'ar', name: 'العربية', dir: 'rtl', locale: 'ar-EG', font: 'IBM Plex Sans Arabic:wght@400;500;600;700' },
  { code: 'ur', name: 'اردو', dir: 'rtl', locale: 'ur-PK', font: 'Noto Nastaliq Urdu:wght@400;600;700' },
  { code: 'fa', name: 'فارسی', dir: 'rtl', locale: 'fa-IR', font: 'Vazirmatn:wght@400;500;600;700' },
  { code: 'en', name: 'English', dir: 'ltr', locale: 'en' },
  { code: 'fr', name: 'Français', dir: 'ltr', locale: 'fr' },
  { code: 'tr', name: 'Türkçe', dir: 'ltr', locale: 'tr' },
  { code: 'id', name: 'Bahasa Indonesia', dir: 'ltr', locale: 'id-ID' },
  { code: 'ms', name: 'Bahasa Melayu', dir: 'ltr', locale: 'ms-MY' },
  { code: 'bn', name: 'বাংলা', dir: 'ltr', locale: 'bn-BD', font: 'Noto Sans Bengali:wght@400;500;600;700' },
  { code: 'es', name: 'Español', dir: 'ltr', locale: 'es' },
  { code: 'de', name: 'Deutsch', dir: 'ltr', locale: 'de' },
  { code: 'ru', name: 'Русский', dir: 'ltr', locale: 'ru' },
];

export const DEFAULT_LANG = 'en';
