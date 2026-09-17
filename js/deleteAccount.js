/**
 * Deleting a Spotifie account.
 *
 * One piece of client code, used by both places a person can ask for this: the
 * Delete account action inside the application, and the page on the website
 * that works whether or not they still have the app installed.
 *
 * What it does is ask; it decides nothing. The request carries the session the
 * browser already holds, and the Edge Function reads who that is from a token
 * Supabase verified. **No account id is sent from here**, because a client that
 * could name an account is a client that could name somebody else's.
 *
 * What it never touches: the person's own music. Their files, the folder they
 * granted through Android's picker, and the index built from it are theirs and
 * belong to the device, not to the account. Nothing in this file deletes a
 * file, a folder or a document, and there is no code path here that could.
 *
 * Signing out happens only after a deletion that actually succeeded. A failed
 * attempt leaves the person exactly where they were, still signed in - being
 * thrown out of an account that still exists is its own small disaster.
 */
(function (global) {
    'use strict';

    /** What somebody has to type to mean it. Compared case-insensitively. */
    var CONFIRMATION = 'DELETE';

    /** The Edge Function that does the work, by name. */
    var FUNCTION_NAME = 'delete-account';

    function auth() {
        return global.spotifieAuth || null;
    }

    /** Has this person typed the word, whatever case they typed it in? */
    function confirms(typed) {
        return String(typed == null ? '' : typed).trim().toUpperCase() === CONFIRMATION;
    }

    /**
     * Something a person can read.
     *
     * Whatever came back from the network or the function is written to the
     * console for whoever is debugging; what is shown says what happened and
     * what to do about it, and never carries a status code, a token or a
     * database's complaint.
     */
    function readable(error) {
        var status = error && (error.status || error.statusCode);

        if (status === 401 || status === 403) {
            return 'Your session has expired. Sign in again to delete your account.';
        }
        if (status === 404) {
            return 'Account deletion is unavailable right now. Please try again later.';
        }
        if (error && /failed to fetch|networkerror|load failed/i.test(String(error.message || ''))) {
            return 'Could not reach the account service. Check your connection and try again.';
        }
        return 'Your account could not be deleted right now. Please try again.';
    }

    /**
     * Delete the signed-in account.
     *
     * Answers { success: true } once the account is gone and the session has
     * been cleared, or { success: false, error: <something to show> }.
     */
    function deleteAccount() {
        var session = auth();
        if (!session) {
            return Promise.resolve({ success: false, error: 'Account deletion is unavailable here.' });
        }

        return Promise.resolve(session.tryGetClient())
            .then(function (client) {
                if (!client) {
                    return { success: false, error: 'Could not reach the account service. Check your connection and try again.' };
                }

                return Promise.resolve(session.getSession()).then(function (current) {
                    if (!current) {
                        return { success: false, error: 'Your session has expired. Sign in again to delete your account.' };
                    }

                    // No body, and no identity in it. The function reads who is
                    // asking from the token this call already carries.
                    return client.functions
                        .invoke(FUNCTION_NAME, { body: {} })
                        .then(function (answer) {
                            if (answer && answer.error) {
                                console.error('Account deletion failed:', answer.error);
                                return { success: false, error: readable(answer.error) };
                            }

                            // Only now: the account is gone, so the session is
                            // worthless and the person becomes a guest.
                            return Promise.resolve(session.signOut())
                                .catch(function () {
                                    /* the account is gone either way */
                                })
                                .then(function () {
                                    return { success: true };
                                });
                        })
                        .catch(function (failure) {
                            console.error('Account deletion failed:', failure);
                            return { success: false, error: readable(failure) };
                        });
                });
            })
            .catch(function (failure) {
                console.error('Account deletion failed:', failure);
                return { success: false, error: readable(failure) };
            });
    }

    global.spotifieDeleteAccount = {
        CONFIRMATION: CONFIRMATION,
        FUNCTION_NAME: FUNCTION_NAME,
        confirms: confirms,
        deleteAccount: deleteAccount,
        // Exposed for the tests, which check that a message shown to somebody
        // never carries a status code or anything from a server.
        _readable: readable
    };
})(typeof window !== 'undefined' ? window : globalThis);
