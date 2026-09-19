/**
 * The dsh home the running CLI boots under — shared by the test scripts that
 * create and clean up a throwaway profile.
 *
 * The ACP profile lives inside the *current* home (`${DSH_HOME:-$HOME/.dsh}`);
 * the launcher never rewrites it, so a test that sets `DSH_HOME` to a scratch
 * directory must clean up in that same directory.
 */
import { homedir } from 'node:os'
import path from 'node:path'

/** The home the running CLI boots under (honours an explicit DSH_HOME). */
export const dshHome = () => process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
