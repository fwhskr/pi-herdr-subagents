/** Shared Python parser for the fake Herdr boundary, never executes shell input. */
export const launchScriptParser = `
def launch_script_path(command):
    words = shlex.split(command)
    if words and words[0].startswith("TMPDIR="):
        words = words[1:]
    if len(words) != 2 or words[0] != "bash":
        raise ValueError("expected [TMPDIR=...] bash <script>")
    return words[1]
`;
