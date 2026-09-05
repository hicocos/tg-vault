import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, EyeOff, LogIn, AlertCircle, ShieldCheck, ArrowLeft } from 'lucide-react';
import { authService } from '../../services/auth';
import { IndeterminateSpinner } from '../ui/IndeterminateSpinner';
import { LanguageToggle } from '../ui/LanguageToggle';


interface LoginPageProps {
    onLogin: (password: string) => Promise<{ success: boolean; error?: string; requiresTOTP?: boolean }>;
    setupRequired?: boolean;
    telegramPinRequired?: boolean;
    onSetup?: (webPassword: string, telegramPin?: string) => Promise<{ success: boolean; error?: string }>;
}

export const LoginPage = ({ onLogin, setupRequired = false, telegramPinRequired = false, onSetup }: LoginPageProps) => {
    const { t } = useTranslation();
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
        <div className="relative min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/30 p-4">
            <div className="absolute right-4 top-4">
                <LanguageToggle />
            </div>
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="w-full max-w-md"
            >
                {/* Logo / Title */}
                <div className="text-center mb-8">
                    <motion.div
                        initial={{ scale: 0.8 }}
                        animate={{ scale: 1 }}
                        transition={{ delay: 0.1, type: 'spring' }}
                        className="inline-block mb-4"
                    >
                        <img
                            src="/logo-160.webp?v=tg-vault"
                            srcSet="/logo-80.webp?v=tg-vault 80w, /logo-160.webp?v=tg-vault 160w"
                            sizes="80px"
                            alt="TG Vault Logo"
                            width="80"
                            height="80"
                            decoding="async"
                            className="w-20 h-20 rounded-2xl shadow-lg shadow-black/10"
                        />
                    </motion.div>
                    <h1 className="text-2xl font-bold tracking-tight text-foreground">TG Vault</h1>
                    <p className="text-muted-foreground mt-1">
                        {setupRequired ? t('login.setupTitle') : (step === 'password' ? t('login.passwordTitle') : t('login.totpTitle'))}
                    </p>
                </div>

                <AnimatePresence mode="wait">
                    {step === 'password' ? (
                        <motion.form
                            key="password-step"
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 20 }}
                            onSubmit={handlePasswordSubmit}
                            className="bg-card border border-border rounded-2xl p-6 shadow-xl shadow-black/5"
                        >
                            {/* Error Message */}
                            {error && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 flex items-center gap-2 text-destructive"
                                >
                                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                                    <span className="text-sm">{error}</span>
                                </motion.div>
                            )}

                            {/* Password Input */}
                            <div className="space-y-2">
                                <label htmlFor="password" className="text-sm font-medium text-foreground">
                                    {setupRequired ? t('login.adminPasswordLabel') : t('login.passwordLabel')}
                                </label>
                                <div className="relative">
                                    <input
                                        id="password"
                                        type={showPassword ? 'text' : 'password'}
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder={setupRequired ? t('login.adminPasswordPlaceholder') : t('login.passwordPlaceholder')}
                                        className="w-full h-12 px-4 pr-12 rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                                        autoFocus
                                        autoComplete={setupRequired ? 'new-password' : 'current-password'}
                                        disabled={loading}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                                        aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                                        title={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                                    >
                                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                    </button>
                                </div>
                            </div>

                            {setupRequired && (
                                <div className="space-y-4 mt-4">
                                    <div className="space-y-2">
                                        <label htmlFor="confirm-password" className="text-sm font-medium text-foreground">
                                            {t('login.confirmPasswordLabel')}
                                        </label>
                                        <input
                                            id="confirm-password"
                                            type={showPassword ? 'text' : 'password'}
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            placeholder={t('login.confirmPasswordPlaceholder')}
                                            autoComplete="new-password"
                                            className="w-full h-12 px-4 rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                                            disabled={loading}
                                        />
                                    </div>
                                    {telegramPinRequired && <div className="space-y-2">
                                        <label htmlFor="telegram-pin" className="text-sm font-medium text-foreground">
                                            {t('login.telegramPinLabel')}
                                        </label>
                                        <input
                                            id="telegram-pin"
                                            type="password"
                                            autoComplete="new-password"
                                            inputMode="numeric"
                                            pattern="[0-9]{4}"
                                            maxLength={4}
                                            value={telegramPin}
                                            onChange={(e) => setTelegramPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                                            placeholder="0000"
                                            className="w-full h-12 px-4 rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                                            disabled={loading}
                                        />
                                        <p className="text-xs text-muted-foreground">{t('login.telegramPinHint')}</p>
                                    </div>}
                                </div>
                            )}

                            <motion.button
                                type="submit"
                                disabled={loading}
                                whileHover={{ scale: loading ? 1 : 1.01 }}
                                whileTap={{ scale: loading ? 1 : 0.99 }}
                                className="w-full h-12 mt-6 rounded-xl bg-primary text-primary-foreground font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {loading ? (
                                    <IndeterminateSpinner label={setupRequired ? t('login.creating') : t('login.signingIn')} size="md" tone="current" />
                                ) : (
                                    <>
                                        <LogIn className="w-5 h-5" />
                                        <span>{setupRequired ? t('login.create') : t('login.signIn')}</span>
                                    </>
                                )}
                            </motion.button>
                        </motion.form>
                    ) : (
                        <motion.form
                            key="totp-step"
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -20 }}
                            onSubmit={handleTOTPSubmit}
                            className="bg-card border border-border rounded-2xl p-6 shadow-xl shadow-black/5"
                        >
                            <button
                                type="button"
                                onClick={() => { setStep('password'); setError(''); }}
                                className="mb-4 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                                <ArrowLeft className="w-3 h-3" /> {t('login.back')}
                            </button>

                            {/* Error Message */}
                            {error && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 flex items-center gap-2 text-destructive"
                                >
                                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                                    <span className="text-sm">{error}</span>
                                </motion.div>
                            )}

                            {/* TOTP Input */}
                            <div className="space-y-4">
                                <div className="text-center">
                                    <ShieldCheck className="w-12 h-12 text-primary mx-auto mb-2 opacity-80" />
                                    <h3 className="text-sm font-medium">{t('login.totpHeading')}</h3>
                                    <p className="text-xs text-muted-foreground mt-1">{t('login.totpHint')}</p>
                                </div>
                                <input
                                    id="totp"
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    maxLength={6}
                                    autoComplete="one-time-code"
                                    value={totpToken}
                                    onChange={(e) => setTotpToken(e.target.value.replace(/\D/g, ''))}
                                    placeholder="000000"
                                    className="w-full h-14 text-center text-2xl font-bold tracking-[0.5em] px-4 rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground placeholder:font-normal placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                                    autoFocus
                                    disabled={loading}
                                />
                            </div>

                            <motion.button
                                type="submit"
                                disabled={loading || totpToken.length !== 6}
                                whileHover={{ scale: loading || totpToken.length !== 6 ? 1 : 1.01 }}
                                whileTap={{ scale: loading || totpToken.length !== 6 ? 1 : 0.99 }}
                                className="w-full h-12 mt-6 rounded-xl bg-primary text-primary-foreground font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {loading ? (
                                    <IndeterminateSpinner label={t('login.verifying')} size="md" tone="current" />
                                ) : (
                                    <>
                                        <ShieldCheck className="w-5 h-5" />
                                        <span>{t('login.verify')}</span>
                                    </>
                                )}
                            </motion.button>
                        </motion.form>
                    )}
                </AnimatePresence>

                {/* Footer */}
                <p className="text-center text-xs text-muted-foreground mt-6">
                    {setupRequired ? t('login.setupFooter') : t('login.sessionFooter')}
                </p>
            </motion.div>
        </div>
    );
};
