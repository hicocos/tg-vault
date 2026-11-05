import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, ArrowRight, AlertCircle, ShieldCheck, ArrowLeft, Lock as LockKeyhole, Monitor } from '../ui/icons';
import { authService } from '../../services/auth';
import { IndeterminateSpinner } from '../ui/IndeterminateSpinner';
import { LanguageToggle } from '../ui/LanguageToggle';
import { normalizeLocale } from '../../i18n/registry';
import { useTheme } from '../../hooks/useTheme';
import '../layout/shell.css';

interface LoginPageProps {
    onLogin: (password: string) => Promise<{ success: boolean; error?: string; requiresTOTP?: boolean }>;
    setupRequired?: boolean;
    telegramPinRequired?: boolean;
    onSetup?: (webPassword: string, telegramPin?: string) => Promise<{ success: boolean; error?: string }>;
}

const loginCopy = {
    'zh-CN': { console: '文件管理控制台', account: '账户访问', setup: '首次设置', signIn: '管理员登录', create: '创建管理员', security: '请勿在公用设备上保存密码。' },
    en: { console: 'FILE MANAGEMENT CONSOLE', account: 'ACCOUNT ACCESS', setup: 'INITIAL SETUP', signIn: 'Administrator sign-in', create: 'Create administrator', security: 'Do not save your password on a shared device.' },
    ru: { console: 'УПРАВЛЕНИЕ ФАЙЛАМИ', account: 'ДОСТУП К АККАУНТУ', setup: 'ПЕРВЫЙ ЗАПУСК', signIn: 'Вход администратора', create: 'Создание администратора', security: 'Не сохраняйте пароль на общедоступном устройстве.' },
};

export const LoginPage = ({ onLogin, setupRequired = false, telegramPinRequired = false, onSetup }: LoginPageProps) => {
    const { t, i18n } = useTranslation();
    const { theme, setTheme } = useTheme();
    const copy = loginCopy[normalizeLocale(i18n.resolvedLanguage || i18n.language)];
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [telegramPin, setTelegramPin] = useState('');
    const [totpToken, setTotpToken] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [step, setStep] = useState<'password' | 'totp'>('password');

    const handlePasswordSubmit = async (e: FormEvent) => {
        e.preventDefault();
        if (loading) return;

        if (setupRequired) {
            if (!password || password.length < 8) {
                setError(t('login.errors.passwordLength'));
                return;
            }
            if (password !== confirmPassword) {
                setError(t('login.errors.passwordMismatch'));
                return;
            }
            if (telegramPinRequired && !/^\d{4}$/.test(telegramPin)) {
                setError(t('login.errors.pinFormat'));
                return;
            }
            if (telegramPinRequired && password === telegramPin) {
                setError(t('login.errors.pinMatchesPassword'));
                return;
            }
            if (!onSetup) {
                setError(t('login.errors.setupUnavailable'));
                return;
            }
            setLoading(true);
            setError('');
            try {
                const result = await onSetup(password, telegramPinRequired ? telegramPin : undefined);
                if (!result.success) {
                    setError(result.error || t('login.errors.setupFailed'));
                    setLoading(false);
                }
            } catch {
                setError(t('login.errors.setupRequestFailed'));
                setLoading(false);
            }
            return;
        }

        if (!password.trim()) {
            setError(t('login.errors.passwordRequired'));
            return;
        }

        setLoading(true);
        setError('');

        try {
            const result = await onLogin(password);
            if (!result.success) {
                setError(result.error || t('login.errors.loginFailed'));
                setLoading(false);
            } else if (result.requiresTOTP) {
                setStep('totp');
                setLoading(false);
            }
        } catch {
            setError(t('login.errors.loginRequestFailed'));
            setLoading(false);
        }
    };

    const handleTOTPSubmit = async (e: FormEvent) => {
        e.preventDefault();
        if (loading) return;

        if (!totpToken.trim() || totpToken.length !== 6) {
            setError(t('login.errors.totpFormat'));
            return;
        }

        setLoading(true);
        setError('');

        try {
            const result = await authService.verifyTOTP(password, totpToken);
            if (!result.success) {
                setError(result.error || t('login.errors.totpFailed'));
                setLoading(false);
            } else {
                window.location.reload();
            }
        } catch {
            setError(t('login.errors.totpRequestFailed'));
            setLoading(false);
        }
    };

    return (
        <main id="main-content" className="tv-login-page tv-textured-canvas">
            <div className="tv-login-preferences">
                <LanguageToggle />
                <label className="tv-login-theme">
                    <Monitor size={15} aria-hidden="true" />
                    <span className="sr-only">{t('settings.general.theme')}</span>
                    <select aria-label={t('settings.general.theme')} value={theme} onChange={event => {
                        const next = event.target.value;
                        if (next === 'light' || next === 'dark' || next === 'system') setTheme(next);
                    }}>
                        <option value="light">{t('settings.general.themeLight')}</option>
                        <option value="dark">{t('settings.general.themeDark')}</option>
                        <option value="system">{t('settings.general.themeSystem')}</option>
                    </select>
                </label>
            </div>
            <a href="/" className="tv-shell-brand">
                <img src="/logo-160.webp?v=logo15-482cd86d" srcSet="/logo-80.webp?v=logo15-482cd86d 80w, /logo-160.webp?v=logo15-482cd86d 160w" sizes="44px" alt="" width="44" height="44" decoding="async" />
                <span className="tv-brand-copy"><strong>{t('app.title')}</strong><small>{copy.console}</small></span>
            </a>

            <section className="tv-login-card" aria-labelledby="login-title">
                <span className="tv-login-eyebrow">{setupRequired ? copy.setup : copy.account}</span>
                <h1 id="login-title">{setupRequired ? copy.create : step === 'password' ? copy.signIn : t('login.totpTitle')}</h1>
                <p className="tv-login-intro">{setupRequired ? t('login.setupTitle') : step === 'password' ? t('login.passwordTitle') : t('login.totpHint')}</p>

                {step === 'password' ? (
                    <form key="password-step" className="tv-login-form" onSubmit={handlePasswordSubmit} aria-busy={loading} noValidate>
                        {error && <div id="login-error" className="tv-login-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{error}</span></div>}
                        <div className="tv-login-field">
                            <label htmlFor="password">{setupRequired ? t('login.adminPasswordLabel') : t('login.passwordLabel')}</label>
                            <div className="tv-login-input-wrap">
                                <input id="password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)}
                                    placeholder={setupRequired ? t('login.adminPasswordPlaceholder') : t('login.passwordPlaceholder')}
                                    autoFocus autoComplete={setupRequired ? 'new-password' : 'current-password'} disabled={loading}
                                    aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} />
                                <button type="button" className="tv-icon-button tv-password-visibility" onClick={() => setShowPassword(!showPassword)} disabled={loading}
                                    aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')} title={showPassword ? t('login.hidePassword') : t('login.showPassword')} aria-pressed={showPassword}>
                                    {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                                </button>
                            </div>
                        </div>
                        {setupRequired && (
                            <>
                                <div className="tv-login-field">
                                    <label htmlFor="confirm-password">{t('login.confirmPasswordLabel')}</label>
                                    <input id="confirm-password" type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)}
                                        placeholder={t('login.confirmPasswordPlaceholder')} autoComplete="new-password" disabled={loading}
                                        aria-describedby={error ? 'login-error' : undefined} />
                                </div>
                                {telegramPinRequired && <div className="tv-login-field">
                                    <label htmlFor="telegram-pin">{t('login.telegramPinLabel')}</label>
                                    <input id="telegram-pin" type="password" autoComplete="new-password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4}
                                        value={telegramPin} onChange={event => setTelegramPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="0000" disabled={loading} aria-describedby="telegram-pin-hint" />
                                    <small id="telegram-pin-hint">{t('login.telegramPinHint')}</small>
                                </div>}
                            </>
                        )}
                        <button type="submit" className="tv-login-submit" disabled={loading}>
                            {loading ? <IndeterminateSpinner label={setupRequired ? t('login.creating') : t('login.signingIn')} size="md" tone="current" />
                                : <><span>{setupRequired ? t('login.create') : t('login.signIn')}</span><ArrowRight size={18} aria-hidden="true" /></>}
                        </button>
                    </form>
                ) : (
                    <form key="totp-step" className="tv-login-form" onSubmit={handleTOTPSubmit} aria-busy={loading}>
                        <button type="button" className="tv-login-back" disabled={loading} onClick={() => { setStep('password'); setError(''); }}><ArrowLeft size={15} aria-hidden="true" />{t('login.back')}</button>
                        {error && <div id="login-error" className="tv-login-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{error}</span></div>}
                        <div className="tv-login-field">
                            <label htmlFor="totp">{t('login.totpHeading')}</label>
                            <input id="totp" className="tv-totp-input" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code"
                                value={totpToken} onChange={event => setTotpToken(event.target.value.replace(/\D/g, ''))} placeholder="000000" autoFocus disabled={loading}
                                aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} />
                        </div>
                        <button type="submit" className="tv-login-submit" disabled={loading || totpToken.length !== 6}>
                            {loading ? <IndeterminateSpinner label={t('login.verifying')} size="md" tone="current" />
                                : <><span>{t('login.verify')}</span><ShieldCheck size={18} aria-hidden="true" /></>}
                        </button>
                    </form>
                )}
                <p className="tv-login-help"><LockKeyhole size={15} aria-hidden="true" /><span>{copy.security}</span></p>
            </section>
            <p className="tv-login-foot">{setupRequired ? t('login.setupFooter') : t('login.sessionFooter')}</p>
        </main>
    );
};
