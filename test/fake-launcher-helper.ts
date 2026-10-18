/** Shared Python parser for the fake Herdr boundary, never executes shell input. */
export const launchScriptParser = `
def launch_script_path(command):
    return shlex.split(command)[1]
`;
