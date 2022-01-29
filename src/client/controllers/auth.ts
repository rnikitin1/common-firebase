import {
    IAuthController,
    AuthUser,
    AuthUserWithProviders,
    AuthProviders,
    MagicLinkRequestReasons,
    AuthResult,
    AuthErrors,
} from '../../abstractions/IAuthController';
import { makeObservable, observable, runInAction } from 'mobx';
import Firebase from '../../client/firebase';
import { createLogger } from '@zajno/common/lib/logger';
import { Event } from '@zajno/common/lib/event';
import { prepareEmail } from '@zajno/common/lib/emails';
import IStorage from '@zajno/common/lib/abstractions/services/storage';
import { Disposable } from '@zajno/common/lib/disposer';
import { FlagModel, NumberModel } from '@zajno/common/lib/viewModels';

export { IAuthController };
export const logger = createLogger('[Auth]');

const AuthProviderIdKey = 'auth:providerid';
const UserSignInEmailStorageKey = 'auth:signin:email';
const MagicLinkReasonKey = 'auth:signin:reason';
const PasswordResetRequestedKey = 'auth:passwordreset';

export default abstract class AuthControllerBase<TUser extends AuthUser = AuthUser> extends Disposable implements IAuthController {
    @observable
    private _authUser: AuthUserWithProviders<TUser> = null;

    protected readonly _initializing = new NumberModel(0);

    private _nextProvider: AuthProviders = null;
    private readonly _magicLinkSucceeded = new Event<MagicLinkRequestReasons>();

    private readonly _setPasswordMode = new FlagModel(false);

    private readonly _onSignOut = new Event();
    private readonly _onPreProcessUser = new Event<AuthUserWithProviders<TUser>>();

    private readonly _firstInit = new FlagModel(true);

    constructor() {
        super();
        makeObservable(this);
        this.disposer.add(
            Firebase.Instance.auth.onAuthStateChanged(async () => {
                this.doInitialization(this.processAuthUser.bind(this));
            }),
        );
    }

    get authUser(): Readonly<AuthUserWithProviders<TUser>> { return this._authUser; }
    get initializing() { return this._firstInit.value || this._initializing.value !== 0; }
    get magicLinkSucceeded() { return this._magicLinkSucceeded.expose(); }

    get setPasswordMode() { return this._setPasswordMode.value; }
    get needsCreatePassword(): boolean | null {
        if (!this.authUser || !this.authUser.providers || !this.authUser.currentProvider
            || this.authUser.currentProvider === AuthProviders.Google
            || this.authUser.currentProvider === AuthProviders.DevLogin) {
            return null;
        }

        return !this.authUser.providers.includes(AuthProviders.EmailAndPassword);
    }

    get onPreProcessUser() { return this._onPreProcessUser.expose(); }
    get onSignOut() { return this._onSignOut.expose(); }

    get appleSignInSupported() { return false; }

    abstract get locationUrl(): string;

    protected abstract get Storage(): IStorage;

    get logger() { return logger; }

    protected async processAuthUser() {
        this._firstInit.setFalse();
        const authUser = Firebase.Instance.auth.currentUser;

        const methods = authUser?.email && await this.getEmailAuthMethod(authUser.email);

        let provider: AuthProviders;
        if (!authUser) {
            provider = null;
        } else if (this._nextProvider) {
            // logger.log('NEXT PROVIDER ====>', this._nextProvider);
            provider = this._nextProvider;
            this._nextProvider = null;
            await this.Storage.setValue(AuthProviderIdKey, provider);
        } else {
            provider = (await this.Storage.getValue(AuthProviderIdKey) || '') as AuthProviders;
        }

        logger.log('Initializing with user:', authUser?.email, '; provider =', provider, '; uid =', authUser?.uid);

        const signedIn = !this._authUser && authUser;
        const result = this.createAuthUser() as AuthUserWithProviders<TUser>;
        if (result) {
            result.providers = methods || [];
            result.currentProvider = provider;
        }

        await this._onPreProcessUser.triggerAsync(result);

        runInAction(() => this._authUser = result);

        if (signedIn) {
            const createPassword = this.needsCreatePassword;
            const resetPassword = provider === AuthProviders.EmailLink && (await this.Storage.getValue(PasswordResetRequestedKey)) === 'true';
            if (createPassword || resetPassword) {
                logger.log('Setting _setPasswordMode = true createPassword =', createPassword, 'resetPassword =', resetPassword);
                this._setPasswordMode.setTrue();
            }
        }
    }

    protected createAuthUser(): TUser {
        const authUser = Firebase.Instance.auth.currentUser;

        const result: AuthUser = authUser ? {
            uid: authUser.uid,
            displayName: authUser.displayName,
            email: authUser.email,
            emailVerified: authUser.emailVerified,
            phoneNumber: authUser.phoneNumber,
            photoURL: authUser.photoURL,
        } : null;

        return result as TUser;
    }

    protected forceEnableSetPasswordMode() {
        this._setPasswordMode.setTrue();
    }

    public skipPasswordMode(): void {
        this._setPasswordMode.setFalse();
        this.Storage.remove(PasswordResetRequestedKey);
    }

    protected setNextProvider(p: AuthProviders) {
        logger.log('next provider =>', p);
        this._nextProvider = p;
    }

    async getEmailAuthMethod(email: string): Promise<AuthProviders[]> {
        const methods = email && typeof email === 'string' && await Firebase.Instance.auth.fetchSignInMethodsForEmail(email);
        const results = (methods || []).map(m => {
            switch (m) {
                case Firebase.Instance.types.FirebaseAuth.EmailAuthProvider.EMAIL_PASSWORD_SIGN_IN_METHOD: {
                    return AuthProviders.EmailAndPassword;
                }

                case Firebase.Instance.types.FirebaseAuth.EmailAuthProvider.EMAIL_LINK_SIGN_IN_METHOD: {
                    return AuthProviders.EmailLink;
                }

                case Firebase.Instance.types.FirebaseAuth.GoogleAuthProvider.PROVIDER_ID: {
                    return AuthProviders.Google;
                }

                default: {
                    return null;
                }
            }
        }).filter(m => m);

        if (results.length === 0) {
            logger.log('No auth methods for email', email, '; existing are:', methods);
        }

        return results;
    }

    async getHasAccount(email: string): Promise<boolean> {
        const methods = await this.getEmailAuthMethod(email);
        return methods.length > 0;
    }

    public signInWithEmailLink(email: string, reason: MagicLinkRequestReasons) {
        return this.sendMagicLinkRequest(email, reason);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected async sendMagicLinkRequest(email: string, reason: MagicLinkRequestReasons, displayName?: string) {
        email = prepareEmail(email);
        logger.log('sendMagicLinkRequest', email, reason);

        // don't use Promise.all here – it crashes Expo
        await this.Storage.setValue(UserSignInEmailStorageKey, email);
        await this.Storage.setValue(MagicLinkReasonKey, reason || 'empty');
        await this.Storage.remove(PasswordResetRequestedKey);

        await Firebase.Instance.auth.sendSignInLinkToEmail(email, {
            url: this.locationUrl,
        });
    }

    protected async processEmailLink(): Promise<{ result?: true, error?: 'invalidLink' | 'noemail' | Error, email?: string }> {
        let email = await this.Storage.getValue(UserSignInEmailStorageKey);
        const url = this.locationUrl;
        try {
            if (!Firebase.Instance.auth.isSignInWithEmailLink(url)) {
                logger.log('Current path is not sign in link:', url);
                return { error: 'invalidLink' };
            }

            email = prepareEmail(email);
            if (!email) {
                logger.log('User was not performing a sign in');
                return { error: 'noemail' };
            }

            this.setNextProvider(AuthProviders.EmailLink);
            await Firebase.Instance.auth.signInWithEmailLink(email, url);

            const reason = await this.Storage.getValue(MagicLinkReasonKey) as MagicLinkRequestReasons;
            this.logger.log('processEmailLink reason =', reason);
            if (reason === MagicLinkRequestReasons.PasswordReset) {
                await this.Storage.setValue(PasswordResetRequestedKey, 'true');
                this._setPasswordMode.setTrue();
            }

            await this.Storage.remove(MagicLinkReasonKey);
            await this.Storage.remove(UserSignInEmailStorageKey);

            this.logger.log('processEmailLink succeed with reason =', reason);
            this._magicLinkSucceeded.trigger(reason);

            return { result: true };

        } catch (err) {
            this.setNextProvider(AuthProviders.None);
            logger.error('Failed to perform a sign in for user:', email, '; Error:', err);
            return {
                error: err,
                email,
            };
        }
    }

    async signInWithEmailPassword(email: string, password: string): Promise<void> {
        const e = prepareEmail(email);

        try {
            this.setNextProvider(AuthProviders.EmailAndPassword);
            await Firebase.Instance.auth.signInWithEmailAndPassword(e, password);
            await this.Storage.remove(PasswordResetRequestedKey);
        } catch (err) {
            this.setNextProvider(AuthProviders.None);
            throw err;
        }
    }

    async createAccountForEmailAndPassword(email: string, password: string): Promise<void> {
        const e = prepareEmail(email);
        logger.log('Creating an account for ', e);
        try {
            this.setNextProvider(AuthProviders.EmailAndPassword);
            await Firebase.Instance.auth.createUserWithEmailAndPassword(e, password);
        } catch (err) {
            this.setNextProvider(AuthProviders.None);
            throw err;
        }
    }

    async updatePassword(password: string, oldPassword?: string): Promise<AuthResult> {
        const authUser = Firebase.Instance.auth.currentUser;
        if (!authUser) {
            return { result: false, error: AuthErrors.InvalidAuthState, original: null };
        }

        try {
            await authUser.updatePassword(password);
            logger.log('password updated successfully!!');
            this._authUser.providers = await this.getEmailAuthMethod(authUser.email);
            this._setPasswordMode.setFalse();
            await this.Storage.remove(PasswordResetRequestedKey);

            return { result: true };
        } catch (err) {
            logger.log('failed to update password:', err.code);
            if (err.code === 'auth/requires-recent-login') {
                if (oldPassword) {
                    const cred = Firebase.Instance.types.FirebaseAuth.EmailAuthProvider.credential(this.authUser.email, oldPassword);
                    try {
                        logger.log('re-authenticating with email/password for', this.authUser.email);
                        await authUser.reauthenticateWithCredential(cred);
                    } catch (err2) {
                        logger.log('failed to re-authenticate, ERROR:', err2);
                        return {
                            result: false,
                            error: err2.code === 'auth/wrong-password'
                                ? AuthErrors.WrongPassword
                                : AuthErrors.InvalidAuthState,
                            original: err2,
                        };
                    }

                    return await this.updatePassword(password);
                }

                return {
                    result: false,
                    error: AuthErrors.NeedsReauthentication,
                    original: err,
                };
            } else {
                throw err;
            }
        }
    }

    protected doGoogleSignIn() {
        const provider = new Firebase.Instance.types.FirebaseAuth.GoogleAuthProvider();
        return Firebase.Instance.auth.signInWithPopup(provider);
    }

    async signInWithGoogle(): Promise<boolean> {
        try {
            this.setNextProvider(AuthProviders.Google);

            const result = await this.doGoogleSignIn();
            if (!result) {
                logger.warn('Google SignIn: no result (probably canceled)');
                this.setNextProvider(AuthProviders.None);
                return false;
            }

            logger.log('Google: Successfully signed in with user', result.user.email);

            // not necessary to init because onAuthStateChanged should be triggered
            // await this.init();
            return true;
        } catch (err) {
            this.setNextProvider(AuthProviders.None);

            // tslint:disable-next-line: triple-equals
            if (err.code == '-3' || (err.message && err.message.includes('error -3'))) {
                logger.log('Cancel sign in with google');
                return false;
            }

            logger.warn('Google Sign in error:', err.message, err);

            // Handle Errors here.
            const errorCode: string = err.code;
            // const errorMessage = err.message;
            // The email of the user's account used.
            const email = err.email;
            // The firebase.auth.AuthCredential type that was used.
            // const credential = err.credential;

            if (errorCode === 'auth/account-exists-with-different-credential') {
                // Construct the email link credential from the current URL.
                const emailCredential = Firebase.Instance.types.FirebaseAuth.EmailAuthProvider.credentialWithLink(
                    email, this.locationUrl);

                // Link the credential to the current user.
                try {
                    await Firebase.Instance.auth.currentUser.linkWithCredential(emailCredential);
                    // The provider is now successfully linked.
                    // The phone user can now sign in with their phone number or email.
                    return false;

                } catch (innerErr) {
                    // Some error occurred.
                }
            }
            throw err;
        }
    }

    async signOut() {
        logger.log('Signing out...');
        this.doInitialization(async () => {
            try {
                this._setPasswordMode.setFalse();

                await this._onSignOut.triggerAsync();

                await this.servicesSignOut();

                await this.Storage.remove(AuthProviderIdKey);
                await this.Storage.remove(MagicLinkReasonKey);

                await Firebase.Instance.auth.signOut();
            } catch (err) {
                logger.warn('Failed to sign out!');
                // eslint-disable-next-line no-console
                console.error(err);
                throw err;
            }
        });
    }

    protected abstract googleSignOut(): Promise<void>;

    protected async servicesSignOut() {
        await this.googleSignOut();
    }

    async updatePhotoUrl(photoUrl: string): Promise<void> {
        await Firebase.Instance.auth.currentUser.updateProfile({
            photoURL: photoUrl,
        });

        runInAction(() => this._authUser.photoURL = Firebase.Instance.auth.currentUser.photoURL);
        logger.log('User photo URL updated:', this._authUser.photoURL);
    }

    protected async doInitialization<T>(cb: () => Promise<T>): Promise<T> {
        try {
            this._initializing.increment(1);
            const res = await cb();
            return res;
        } finally {
            this._initializing.decrement(1);
        }
    }
}
