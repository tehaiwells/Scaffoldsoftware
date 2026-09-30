// The passphrase for an encrypted backup copy: from SCAFFOLD_BACKUP_PASSPHRASE, or typed at the keyboard without being shown on screen.
// null when nobody is at a keyboard (and the variable is not set), or when Ctrl+C is pressed.
export async function askPassphrase(prompt='Passphrase for the encrypted copy (not shown): '){
  if(process.env.SCAFFOLD_BACKUP_PASSPHRASE)return process.env.SCAFFOLD_BACKUP_PASSPHRASE;
  if(!process.stdin.isTTY)return null;
  process.stdout.write(prompt);
  return new Promise(resolve=>{let text='';process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
    const done=value=>{process.stdin.setRawMode(false);process.stdin.pause();process.stdin.off('data',on);process.stdout.write('\n');resolve(value);};
    const on=ch=>{for(const c of ch){if(c==='\r'||c==='\n')return done(text);if(c==='\u0003')return done(null);if(c==='\u007f'||c==='\b')text=text.slice(0,-1);else text+=c;}};
    process.stdin.on('data',on);});
}
