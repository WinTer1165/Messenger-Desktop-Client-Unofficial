/**
 * Browser Login Handler
 *
 * This handles login via a separate browser window by:
 * 1. Opening a BrowserWindow to Facebook/Messenger
 * 2. User logs in with existing browser cookies OR creates new login
 * 3. After successful login detected, we extract session cookies
 * 4. Cookies are transferred to the main app session
 *
 * Benefits:
 * - Uses system browser's existing login (if available)
 * - Works with 2FA, biometrics, all Facebook security features
 * - Password never touches main app
 * - Can detect successful login automatically
 * - More reliable than external browser cookie extraction
 */

import { BrowserWindow, Cookie } from 'electron';

interface LoginResult {
  success: boolean;
  cookies?: Cookie[];
  error?: string;
}

export class BrowserLogin {
  private loginWindow: BrowserWindow | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private resolvePromise: ((result: LoginResult) => void) | null = null;
  private isCleanedUp: boolean = false;

  /**
   * Start browser login flow
   */
  async startLogin(): Promise<LoginResult> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;

      console.log('[BrowserLogin] Creating login window...');

      // Create a separate browser window for login
      // Using default session to benefit from system browser's cookies
      this.loginWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        center: true,
        title: 'Login to Facebook',
        webPreferences: {
          // Use default partition to potentially share cookies with system browser
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false, // Need to disable sandbox for better cookie access
          webSecurity: true,
        },
      });

      // Start with Messenger.com (will redirect to login if needed)
      this.loginWindow.loadURL('https://www.messenger.com').catch((error) => {
        console.error('[BrowserLogin] Failed to load login page:', error);
        // Only cleanup if not already done
        if (!this.isCleanedUp) {
          this.cleanup({
            success: false,
            error: 'Failed to load login page'
          });
        }
      });

      // Handle window close
      this.loginWindow.on('closed', () => {
        console.log('[BrowserLogin] Window closed by user');
        this.cleanup({
          success: false,
          error: 'Login cancelled by user'
        });
      });

      // Monitor navigation to detect successful login
      this.loginWindow.webContents.on('did-navigate', (_event, url) => {
        this.checkLoginSuccess(url);
      });

      this.loginWindow.webContents.on('did-navigate-in-page', (_event, url) => {
        this.checkLoginSuccess(url);
      });

      // Set timeout (5 minutes)
      this.timeout = setTimeout(() => {
        console.log('[BrowserLogin] Login timeout');
        this.cleanup({
          success: false,
          error: 'Login timeout - please try again'
        });
      }, 300000);

      console.log('[BrowserLogin] Login window opened');
    });
  }

  /**
   * Check if the current URL indicates successful login
   */
  private checkLoginSuccess(url: string): void {
    console.log('[BrowserLogin] Navigation detected:', url);

    // Check if we've successfully logged in to Facebook/Messenger
    // Successful login URLs include:
    // - https://www.facebook.com/ (after login)
    // - https://www.messenger.com/
    // - https://www.facebook.com/messages/
    const loggedInPatterns = [
      /^https:\/\/(www\.)?facebook\.com\/?$/,
      /^https:\/\/(www\.)?messenger\.com/,
      /^https:\/\/(www\.)?facebook\.com\/messages/,
      /^https:\/\/(www\.)?facebook\.com\/\?sk=/, // Facebook home with sections
    ];

    const isLoggedIn = loggedInPatterns.some(pattern => pattern.test(url));

    if (isLoggedIn) {
      console.log('[BrowserLogin] Login detected! Extracting cookies...');
      this.extractCookies();
    }
  }

  /**
   * Extract cookies from the login window session
   */
  private async extractCookies(): Promise<void> {
    if (!this.loginWindow || this.loginWindow.isDestroyed()) {
      this.cleanup({
        success: false,
        error: 'Login window was closed'
      });
      return;
    }

    try {
      // Get the session from the login window
      const loginSession = this.loginWindow.webContents.session;

      // Extract Facebook cookies
      const cookies = await loginSession.cookies.get({
        domain: '.facebook.com'
      });

      const messengerCookies = await loginSession.cookies.get({
        domain: '.messenger.com'
      });

      const allCookies = [...cookies, ...messengerCookies];

      console.log(`[BrowserLogin] Extracted ${allCookies.length} cookies`);

      // Check if we got the essential session cookies
      const hasSessionCookies = allCookies.some(c => c.name === 'c_user' || c.name === 'xs');

      if (hasSessionCookies) {
        console.log('[BrowserLogin] Valid session cookies found!');
        this.cleanup({
          success: true,
          cookies: allCookies
        });
      } else {
        console.warn('[BrowserLogin] No session cookies found, login may not be complete');
        // Don't cleanup yet, keep waiting
      }
    } catch (error) {
      console.error('[BrowserLogin] Cookie extraction error:', error);
      this.cleanup({
        success: false,
        error: 'Failed to extract cookies'
      });
    }
  }

  /**
   * Clean up and resolve
   */
  private cleanup(result: LoginResult): void {
    // Prevent multiple cleanup calls
    if (this.isCleanedUp) {
      return;
    }
    this.isCleanedUp = true;

    console.log('[BrowserLogin] Cleanup:', result.success ? 'Success' : 'Failed');

    // Clear timeout
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    // Clear check interval
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // Close login window (remove event listeners first to avoid recursion)
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.removeAllListeners('closed');
      this.loginWindow.webContents.removeAllListeners('did-navigate');
      this.loginWindow.webContents.removeAllListeners('did-navigate-in-page');
      this.loginWindow.close();
    }
    this.loginWindow = null;

    // Resolve promise
    if (this.resolvePromise) {
      this.resolvePromise(result);
      this.resolvePromise = null;
    }
  }

  /**
   * Force stop (called externally if needed)
   */
  stop(): void {
    this.cleanup({
      success: false,
      error: 'Cancelled by user'
    });
  }
}
