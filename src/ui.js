const ANSI = {
  bold: ['\u001b[1m', '\u001b[22m'],
  cyan: ['\u001b[36m', '\u001b[39m'],
  dim: ['\u001b[2m', '\u001b[22m'],
  green: ['\u001b[32m', '\u001b[39m'],
  yellow: ['\u001b[33m', '\u001b[39m'],
};

function colorize(enabled, name, value) {
  if (!enabled) {
    return value;
  }

  const [open, close] = ANSI[name];
  return `${open}${value}${close}`;
}

export function createUi({ env = process.env, io, plain = false } = {}) {
  const interactive = Boolean(io?.isTty) && !plain && !env.NO_COLOR && !env.CI;

  return {
    interactive,
    bold(value) {
      return colorize(interactive, 'bold', value);
    },
    cyan(value) {
      return colorize(interactive, 'cyan', value);
    },
    dim(value) {
      return colorize(interactive, 'dim', value);
    },
    green(value) {
      return colorize(interactive, 'green', value);
    },
    yellow(value) {
      return colorize(interactive, 'yellow', value);
    },
    symbol(name) {
      if (!interactive) {
        return name;
      }

      return {
        missing: '!',
        ready: 'ok',
        warm: '>',
      }[name];
    },
    startSpinner(text) {
      if (!interactive || typeof io?.writeStdout !== 'function') {
        return {
          stop() {},
        };
      }

      const frames = ['-', '\\', '|', '/'];
      let index = 0;

      io.writeStdout(`${colorize(true, 'cyan', frames[index])} ${text}\r`);

      const timer = setInterval(() => {
        index = (index + 1) % frames.length;
        io.writeStdout(`${colorize(true, 'cyan', frames[index])} ${text}\r`);
      }, 80);

      timer.unref?.();

      return {
        stop() {
          clearInterval(timer);
          io.writeStdout('\u001b[2K\r');
        },
      };
    },
  };
}
