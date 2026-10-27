/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Component, ErrorInfo, ReactNode, useEffect, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { UsernameAuthGate } from './components/AuthAndVaultGate';
import { BackupSourceView } from './components/BackupSourceView';
import { DevicesView } from './components/DevicesView';
import { ExportModal } from './components/Dialogs';
import { RecordsExplorerView } from './components/RecordsExplorerView';
import { SecurityAndAccountView } from './components/SecurityAndAccountView';
import { CloudRepo } from './core/cloudRepo';
import { KeyVault } from './core/crypto';
import {
  auth,
  bootstrapFirebaseSession,
  friendlyErrorMessageAr,
  isTokenServiceDisabledError,
  SessionBootstrapState,
} from './core/firebase';
import { LocalDevicePrefs, LocalPrefsStore } from './core/localQueue';
import { DeviceInfo } from './core/types';
import { AuthSessionResult, UsernameAuth } from './core/usernameAuth';

type ActiveSection = 'devices' | 'explorer' | 'backup' | 'security';

interface ErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Application ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-xl px-6 py-20">
          <div className="rounded-xl border border-red-200 bg-white p-7">
            <h1 className="text-lg font-bold text-slate-900">حدث خطأ غير متوقع أثناء التشغيل</h1>
            <p className="mt-2 text-sm text-red-700">{friendlyErrorMessageAr(this.state.error)}</p>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="mt-5 rounded-lg bg-[#1F3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#162a47]"
            >
              إعادة المحاولة
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState<string>('');
  const [sessionNotice, setSessionNotice] = useState<SessionBootstrapState | null>(null);
  const [vaultKey, setVaultKey] = useState<CryptoKey | null>(null);
  const [prefs, setPrefs] = useState<LocalDevicePrefs | null>(null);
  const [section, setSection] = useState<ActiveSection>('devices');
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const [exportDevice, setExportDevice] = useState<DeviceInfo | null>(null);
  const [cloudRefreshCounter, setCloudRefreshCounter] = useState(0);

  useEffect(() => {
    let disposed = false;
    let unsubAuth: (() => void) | null = null;
    let expiryTimer: number | null = null;

    const clearExpiryTimer = () => {
      if (expiryTimer !== null) {
        window.clearTimeout(expiryTimer);
        expiryTimer = null;
      }
    };

    const scheduleTokenRefresh = async (activeUser: User) => {
      try {
        const tokenResult = await activeUser.getIdTokenResult(false);
        const expMs = Date.parse(tokenResult.expirationTime);
        if (!Number.isNaN(expMs) && !disposed) {
          const msUntilCheck = Math.max(10_000, expMs - Date.now() - 45_000);
          expiryTimer = window.setTimeout(() => {
            void (async () => {
              try {
                await activeUser.getIdToken(true);
              } catch (err) {
                const disabled = isTokenServiceDisabledError(err);
                await UsernameAuth.signOut();
                if (!disposed) {
                  setSessionNotice({
                    sessionExpiredReset: true,
                    tokenServiceDisabled: disabled,
                    activationUrl: null,
                  });
                }
              }
            })();
          }, msUntilCheck);
        }
      } catch {
        // Handled by auth guard
      }
    };

    void (async () => {
      const boot = await bootstrapFirebaseSession();
      if (disposed) return;
      if (boot.sessionExpiredReset) {
        setSessionNotice(boot);
      }

      unsubAuth = onAuthStateChanged(auth, (nextUser) => {
        clearExpiryTimer();
        void (async () => {
          if (UsernameAuth.inProgress) {
            if (nextUser) {
              await scheduleTokenRefresh(nextUser);
            }
            if (!disposed) setAuthReady(true);
            return;
          }

          if (nextUser) {
            try {
              const cachedKey = await KeyVault.load(nextUser.uid);
              if (!cachedKey) {
                await UsernameAuth.signOut();
                if (!disposed) {
                  setUser(null);
                  setVaultKey(null);
                  setPrefs(null);
                  setAuthReady(true);
                }
                return;
              }

              await scheduleTokenRefresh(nextUser);
              const loadedPrefs = LocalPrefsStore.load(nextUser.uid);
              let resolvedName = UsernameAuth.getSavedUsername() || nextUser.displayName || '';
              if (!resolvedName) {
                try {
                  resolvedName = (await CloudRepo.getCurrentUsername()) || '';
                } catch {
                  // Offline or transient; keep empty fallback
                }
              }

              if (!disposed) {
                setSessionNotice(null);
                setUser(nextUser);
                setVaultKey(cachedKey);
                setPrefs(loadedPrefs);
                setUsername(resolvedName);
              }
            } catch (err) {
              const disabled = isTokenServiceDisabledError(err);
              await UsernameAuth.signOut();
              if (!disposed) {
                setUser(null);
                setPrefs(null);
                setVaultKey(null);
                setSessionNotice({
                  sessionExpiredReset: true,
                  tokenServiceDisabled: disabled,
                  activationUrl: null,
                });
              }
            }
          } else if (!disposed) {
            setUser(null);
            setVaultKey(null);
            setSelectedDevice(null);
            setExportDevice(null);
            setPrefs(null);
          }

          if (!disposed) {
            setAuthReady(true);
          }
        })();
      });
    })();

    return () => {
      disposed = true;
      clearExpiryTimer();
      if (unsubAuth) unsubAuth();
    };
  }, []);

  const handleAuthenticated = (session: AuthSessionResult) => {
    setSessionNotice(null);
    setUser(session.user);
    setVaultKey(session.vaultKey);
    setPrefs(session.prefs);
    setUsername(session.username);
    setSelectedDevice(null);
    setExportDevice(null);
    setSection('devices');
  };

  const handleSignOut = async () => {
    await UsernameAuth.signOut();
  };

  const isAuthenticated = Boolean(user && vaultKey && prefs);

  return (
    <AppErrorBoundary>
      <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
        {/* Strict 3-Zone Top Bar Contract */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-8 border-b border-slate-200 bg-white px-6 py-4">
          {/* Zone 1: Single text element Brand wordmark */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              if (isAuthenticated) setSection('devices');
            }}
            className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            نسخي الاحتياطي
          </a>

          {/* Zone 2: 4 concise single-line text navigation links */}
          {isAuthenticated ? (
            <nav
              aria-label="التنقل الرئيسي"
              className="hidden md:flex items-center gap-6 text-sm font-semibold text-slate-600"
            >
              <button
                type="button"
                onClick={() => setSection('devices')}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
                  section === 'devices'
                    ? 'border-b-2 border-[#1F3A5F] text-slate-900'
                    : 'hover:text-slate-900'
                }`}
              >
                الأجهزة
              </button>
              <button
                type="button"
                onClick={() => setSection('explorer')}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
                  section === 'explorer'
                    ? 'border-b-2 border-[#1F3A5F] text-slate-900'
                    : 'hover:text-slate-900'
                }`}
              >
                استعراض السجلات
              </button>
              <button
                type="button"
                onClick={() => setSection('backup')}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
                  section === 'backup'
                    ? 'border-b-2 border-[#1F3A5F] text-slate-900'
                    : 'hover:text-slate-900'
                }`}
              >
                النسخ والاستيراد
              </button>
              <button
                type="button"
                onClick={() => setSection('security')}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
                  section === 'security'
                    ? 'border-b-2 border-[#1F3A5F] text-slate-900'
                    : 'hover:text-slate-900'
                }`}
              >
                الأمان والحساب
              </button>
            </nav>
          ) : (
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-500">
              <span className="whitespace-nowrap shrink-0">سجل المكالمات</span>
              <span className="whitespace-nowrap shrink-0">الرسائل النصية</span>
              <span className="whitespace-nowrap shrink-0">الحافظة اليدوية</span>
              <span className="whitespace-nowrap shrink-0">تصدير موثّق</span>
            </nav>
          )}

          {/* Zone 3: 1 primary action */}
          <div className="flex items-center shrink-0">
            {isAuthenticated ? (
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                تسجيل الخروج
              </button>
            ) : (
              <span className="font-mono text-xs font-semibold text-slate-600 whitespace-nowrap shrink-0">
                AES-256-GCM
              </span>
            )}
          </div>
        </header>

        {/* Mobile section switcher below header (non-sticky to respect <= 15% mobile sticky cap) */}
        {isAuthenticated && (
          <div className="border-b border-slate-200 bg-white px-4 py-2 md:hidden">
            <div className="flex items-center gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
              {(
                [
                  ['devices', 'الأجهزة'],
                  ['explorer', 'السجلات'],
                  ['backup', 'النسخ والاستيراد'],
                  ['security', 'الأمان'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSection(id)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 ${
                    section === id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <main className="flex-1">
          {!authReady ? (
            <div className="mx-auto max-w-md px-6 py-20">
              <div className="rounded-xl border border-slate-200 bg-white p-8">
                <div className="h-6 w-36 rounded bg-slate-200" />
                <div className="mt-5 h-10 w-full rounded-lg bg-slate-100" />
                <div className="mt-4 h-10 w-full rounded-lg bg-slate-100" />
              </div>
            </div>
          ) : !isAuthenticated ? (
            <UsernameAuthGate
              onAuthenticated={handleAuthenticated}
              sessionNotice={sessionNotice}
            />
          ) : user && vaultKey && prefs ? (
            <div className="mx-auto max-w-6xl px-6 py-8">
              {section === 'devices' && (
                <DevicesView
                  currentDeviceId={prefs.deviceId}
                  refreshSignal={cloudRefreshCounter}
                  onInspectDevice={(dev) => {
                    setSelectedDevice(dev);
                    setSection('explorer');
                  }}
                  onExportDevice={(dev) => setExportDevice(dev)}
                  onGoToBackupSource={() => setSection('backup')}
                />
              )}

              {section === 'explorer' && (
                <RecordsExplorerView
                  vaultKey={vaultKey}
                  selectedDevice={selectedDevice}
                  onSelectDevice={(dev) => setSelectedDevice(dev)}
                  onBackToDevices={() => setSection('devices')}
                  onOpenExport={(dev) => setExportDevice(dev)}
                />
              )}

              {section === 'backup' && (
                <BackupSourceView
                  uid={user.uid}
                  vaultKey={vaultKey}
                  prefs={prefs}
                  onUpdatePrefs={setPrefs}
                  onCloudChanged={() => setCloudRefreshCounter((c) => c + 1)}
                />
              )}

              {section === 'security' && (
                <SecurityAndAccountView
                  user={user}
                  username={username}
                  prefs={prefs}
                  onCloudChanged={() => setCloudRefreshCounter((c) => c + 1)}
                />
              )}
            </div>
          ) : null}
        </main>

        <footer className="border-t border-slate-200 bg-white px-6 py-4 text-xs text-slate-500">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
            <span>نسخي الاحتياطي والعارض المشفّر — حساب موحّد بين التطبيقين وتشفير طرفي كامل</span>
            <span>احتفظ باسم المستخدم وكلمة المرور في مكان آمن</span>
          </div>
        </footer>

        {exportDevice && vaultKey && (
          <ExportModal
            device={exportDevice}
            vaultKey={vaultKey}
            onClose={() => setExportDevice(null)}
          />
        )}
      </div>
    </AppErrorBoundary>
  );
}
