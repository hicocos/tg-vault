import { useState, type FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, EyeOff, LogIn, AlertCircle, ShieldCheck, ArrowLeft } from 'lucide-react';
import { authService } from '../../services/auth';
import { IndeterminateSpinner } from '../ui/IndeterminateSpinner';

interface LoginPageProps {
    onLogin: (password: string) => Promise<{ success: boolean; error?: string; requiresTOTP?: boolean }>;
    setupRequired?: boolean;
    onSetup?: (webPassword: string, telegramPin: string) => Promise<{ success: boolean; error?: string }>;
}

export const LoginPage = ({ onLogin, setupRequired = false, onSetup }: LoginPageProps) => {
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
                setError('网页管理员密码至少需要 8 位');
                return;
            }
            if (password !== confirmPassword) {
                setError('两次输入的网页密码不一致');
                return;
            }
            if (!/^\d{4}$/.test(telegramPin)) {
                setError('Telegram Bot 密码必须是 4 位数字');
                return;
            }
            if (password === telegramPin) {
                setError('网页密码不能与 Telegram Bot 4 位密码相同');
                return;
            }
            if (!onSetup) {
                setError('初始化接口未就绪');
                return;
            }
            setLoading(true);
            setError('');
            try {
                const result = await onSetup(password, telegramPin);
                if (!result.success) {
                    setError(result.error || '初始化失败');
                    setLoading(false);
                }
            } catch {
                setError('初始化请求失败');
                setLoading(false);
            }
            return;
        }

        if (!password.trim()) {
            setError('请输入密码');
            return;
        }

        setLoading(true);
        setError('');

        try {
            const result = await onLogin(password);

            if (!result.success) {
                setError(result.error || '登录失败');
                setLoading(false);
            } else if (result.requiresTOTP) {
                setStep('totp');
                setLoading(false);
            }
            // 如果成功且不需要 TOTP，App.tsx 会处理状态跳转
        } catch {
            setError('登录请求失败');
            setLoading(false);
        }
    };

    const handleTOTPSubmit = async (e: FormEvent) => {
        e.preventDefault();

        if (!totpToken.trim() || totpToken.length !== 6) {
            setError('请输入 6 位数字验证码');
            return;
        }

        setLoading(true);
        setError('');

        try {
            const result = await authService.verifyTOTP(password, totpToken);

            if (!result.success) {
                setError(result.error || '验证失败');
                setLoading(false);
            } else {
                // 验证成功，页面会自动因为认证状态改变而卸载
                window.location.reload(); // 简单处理，或者在 App.tsx 中通过状态流转
            }
        } catch {
            setError('验证请求失败');
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/30 p-4">
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
                            src="/logo.png?v=tg-vault"
                            alt="TG Vault Logo"
                            className="w-20 h-20 rounded-2xl shadow-lg shadow-black/10"
                        />
                    </motion.div>
                    <h1 className="text-2xl font-bold tracking-tight text-foreground">TG Vault</h1>
                    <p className="text-muted-foreground mt-1">
                        {setupRequired ? '首次启动，请创建唯一管理员密码' : (step === 'password' ? '请输入访问密码' : '双重身份验证')}
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
                                    {setupRequired ? '网页管理员密码' : '访问密码'}
                                </label>
                                <div className="relative">
                                    <input
                                        id="password"
                                        type={showPassword ? 'text' : 'password'}
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder={setupRequired ? '至少 8 位，建议使用强密码' : '请输入密码'}
                                        className="w-full h-12 px-4 pr-12 rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                                        autoFocus
                                        disabled={loading}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                                        aria-label={showPassword ? '隐藏密码' : '显示密码'}
                                        title={showPassword ? '隐藏密码' : '显示密码'}
                                    >
                                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                    </button>
                                </div>
                            </div>

                            {setupRequired && (
                                <div className="space-y-4 mt-4">
                                    <div className="space-y-2">
                                        <label htmlFor="confirm-password" className="text-sm font-medium text-foreground">
                                            确认网页密码
                                        </label>
                                        <input
                                            id="confirm-password"
                                            type={showPassword ? 'text' : 'password'}
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            placeholder="再次输入网页管理员密码"
                                            className="w-full h-12 px-4 rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                                            disabled={loading}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label htmlFor="telegram-pin" className="text-sm font-medium text-foreground">
                                            Telegram Bot 密码（4 位数字）
                                        </label>
                                        <input
                                            id="telegram-pin"
                                            type="password"
                                            inputMode="numeric"
                                            pattern="[0-9]*"
                                            maxLength={4}
                                            value={telegramPin}
                                            onChange={(e) => setTelegramPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                                            placeholder="0000"
                                            className="w-full h-12 px-4 rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                                            disabled={loading}
                                        />
                                        <p className="text-xs text-muted-foreground">首次创建后会二次加密存入数据库，不再允许无密码访问。</p>
                                    </div>
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
                                    <IndeterminateSpinner label={setupRequired ? "正在创建管理员" : "正在登录"} size="md" tone="current" />
                                ) : (
                                    <>
                                        <LogIn className="w-5 h-5" />
                                        <span>{setupRequired ? '创建管理员并进入' : '登录'}</span>
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
                                <ArrowLeft className="w-3 h-3" /> 返回修改密码
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
                                    <h3 className="text-sm font-medium">输入身份验证码</h3>
                                    <p className="text-xs text-muted-foreground mt-1">请输入您身份验证器 App 生成的 6 位数字</p>
                                </div>
                                <input
                                    id="totp"
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    maxLength={6}
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
                                    <IndeterminateSpinner label="正在验证身份验证码" size="md" tone="current" />
                                ) : (
                                    <>
                                        <ShieldCheck className="w-5 h-5" />
                                        <span>验证并登录</span>
                                    </>
                                )}
                            </motion.button>
                        </motion.form>
                    )}
                </AnimatePresence>

                {/* Footer */}
                <p className="text-center text-xs text-muted-foreground mt-6">
                    {setupRequired ? '生产环境首次访问必须先创建网页密码和 Telegram Bot 4 位密码' : '登录状态将保留 7 天'}
                </p>
            </motion.div>
        </div>
    );
};
