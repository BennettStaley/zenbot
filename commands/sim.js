const tb = require('timebucket');
const minimist = require('minimist');
const n = require('numbro');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const colors = require('colors');

module.exports = function container(get) {
  const c = get('conf');
  return program => {
    program
      .command('sim [selector]')
      .allowUnknownOption()
      .description('run a simulation on backfilled data')
      .option('--conf <path>', 'path to optional conf overrides file')
      .option('--strategy <name>', 'strategy to use', String, c.strategy)
      .option(
        '--order_type <type>',
        'order type to use (maker/taker)',
        /^(maker|taker)$/i,
        c.order_type,
      )
      .option(
        '--filename <filename>',
        'filename for the result output (ex: result.html). "none" to disable',
        String,
        c.filename,
      )
      .option('--start <timestamp>', 'start at timestamp')
      .option('--end <timestamp>', 'end at timestamp')
      .option('--days <days>', 'set duration by day count', Number, c.days)
      .option(
        '--currency_capital <amount>',
        'amount of start capital in currency',
        Number,
        c.currency_capital,
      )
      .option(
        '--asset_capital <amount>',
        'amount of start capital in asset',
        Number,
        c.asset_capital,
      )
      .option(
        '--avg_slippage_pct <pct>',
        'avg. amount of slippage to apply to trades',
        Number,
        c.avg_slippage_pct,
      )
      .option(
        '--buy_pct <pct>',
        'buy with this % of currency balance',
        Number,
        c.buy_pct,
      )
      .option(
        '--sell_pct <pct>',
        'sell with this % of asset balance',
        Number,
        c.sell_pct,
      )
      .option(
        '--markdown_buy_pct <pct>',
        '% to mark down buy price',
        Number,
        c.markdown_buy_pct,
      )
      .option(
        '--markup_sell_pct <pct>',
        '% to mark up sell price',
        Number,
        c.markup_sell_pct,
      )
      .option(
        '--order_adjust_time <ms>',
        'adjust bid/ask on this interval to keep orders competitive',
        Number,
        c.order_adjust_time,
      )
      .option(
        '--sell_stop_pct <pct>',
        'sell if price drops below this % of bought price',
        Number,
        c.sell_stop_pct,
      )
      .option(
        '--buy_stop_pct <pct>',
        'buy if price surges above this % of sold price',
        Number,
        c.buy_stop_pct,
      )
      .option(
        '--profit_stop_enable_pct <pct>',
        'enable trailing sell stop when reaching this % profit',
        Number,
        c.profit_stop_enable_pct,
      )
      .option(
        '--profit_stop_pct <pct>',
        'maintain a trailing stop this % below the high-water mark of profit',
        Number,
        c.profit_stop_pct,
      )
      .option(
        '--max_sell_loss_pct <pct>',
        'avoid selling at a loss pct under this float',
        c.max_sell_loss_pct,
      )
      .option(
        '--max_slippage_pct <pct>',
        'avoid selling at a slippage pct above this float',
        c.max_slippage_pct,
      )
      .option(
        '--symmetrical',
        'reverse time at the end of the graph, normalizing buy/hold to 0',
        c.symmetrical,
      )
      .option(
        '--rsi_periods <periods>',
        'number of periods to calculate RSI at',
        Number,
        c.rsi_periods,
      )
      .option('--disable_options', 'disable printing of options')
      .option('--enable_stats', 'enable printing order stats')
      .option('--verbose', 'print status lines on every period')
      .action((selector, cmd) => {
        const s = { options: minimist(process.argv) };
        const so = s.options;
        delete so._;
        Object.keys(c).forEach(k => {
          if (typeof cmd[k] !== 'undefined') {
            so[k] = cmd[k];
          }
        });
        if (so.start) {
          so.start = moment(so.start, moment.ISO_8601).valueOf();
          if (so.days && !so.end) {
            so.end = tb(so.start)
              .resize('1d')
              .add(so.days)
              .toMilliseconds();
          }
        }
        if (so.end) {
          so.end = moment(so.end, moment.ISO_8601).valueOf();
          if (so.days && !so.start) {
            so.start = tb(so.end)
              .resize('1d')
              .subtract(so.days)
              .toMilliseconds();
          }
        }
        if (!so.start && so.days) {
          const d = tb('1d');
          so.start = d.subtract(so.days).toMilliseconds();
        }
        so.stats = !!cmd.enable_stats;
        so.show_options = !cmd.disable_options;
        so.verbose = !!cmd.verbose;
        so.selector = get('lib.normalize-selector')(selector || c.selector);
        so.mode = 'sim';
        if (cmd.conf) {
          const overrides = require(`${path.resolve(process.cwd(), cmd.conf)}`);
          Object.keys(overrides).forEach(k => {
            so[k] = overrides[k];
          });
        }
        const engine = get('lib.engine')(s);
        if (!so.min_periods) so.min_periods = 1;
        let cursor;
        let reversing;
        let reversePoint;
        const queryStart = so.start
          ? tb(so.start)
              .resize(so.period)
              .subtract(so.min_periods + 2)
              .toMilliseconds()
          : null;

        function exitSim() {
          console.log();
          if (!s.period) {
            console.error(
              `no trades found! try running zenbot backfill ${
                so.selector
              } first`,
            );
            process.exit(1);
          }
          const optionKeys = Object.keys(so);
          const outputLines = [];
          optionKeys.sort((a, b) => {
            if (a < b) return -1;
            return 1;
          });
          const options = {};
          optionKeys.forEach(k => {
            options[k] = so[k];
          });
          if (so.show_options) {
            const options_json = JSON.stringify(options, null, 2);
            outputLines.push(options_json);
          }
          if (s.my_trades.length) {
            s.my_trades.push({
              price: s.period.close,
              size: s.balance.asset,
              type: 'sell',
              time: s.period.time,
            });
          }
          s.balance.currency = n(s.balance.currency)
            .add(n(s.period.close).multiply(s.balance.asset))
            .format('0.00000000');
          s.balance.asset = 0;
          s.lookback.unshift(s.period);
          const profit = s.start_capital
            ? n(s.balance.currency)
                .subtract(s.start_capital)
                .divide(s.start_capital)
            : n(0);
          outputLines.push(
            `end balance: ${
              n(s.balance.currency).format('0.00000000').yellow
            } (${profit.format('0.00%')})`,
          );
          // console.log('start_capital', s.start_capital)
          // console.log('start_price', n(s.start_price).format('0.00000000'))
          // console.log('close', n(s.period.close).format('0.00000000'))
          const buyHold = s.start_price
            ? n(s.period.close).multiply(
                n(s.start_capital).divide(s.start_price),
              )
            : n(s.balance.currency);
          // console.log('buy hold', buyHold.format('0.00000000'))
          const buyHoldProfit = s.start_capital
            ? n(buyHold)
                .subtract(s.start_capital)
                .divide(s.start_capital)
            : n(0);
          outputLines.push(
            `buy hold: ${buyHold.format('0.00000000').yellow} (${n(
              buyHoldProfit,
            ).format('0.00%')})`,
          );
          outputLines.push(
            `vs. buy hold: ${
              n(s.balance.currency)
                .subtract(buyHold)
                .divide(buyHold)
                .format('0.00%').yellow
            }`,
          );
          outputLines.push(
            `${s.my_trades.length} trades over ${s.day_count} days (avg ${n(
              s.my_trades.length / s.day_count,
            ).format('0.00')} trades/day)`,
          );
          let lastBuy;
          let losses = 0;
          let sells = 0;
          s.my_trades.forEach(trade => {
            if (trade.type === 'buy') {
              lastBuy = trade.price;
            } else {
              if (lastBuy && trade.price < lastBuy) {
                losses += 1;
              }
              sells += 1;
            }
          });
          if (s.my_trades.length) {
            outputLines.push(`win/loss: ${sells - losses} / ${losses}`);
            outputLines.push(
              `error rate: ${
                (sells
                  ? n(losses)
                      .divide(sells)
                      .format('0.00%')
                  : '0.00%'
                ).yellow
              }`,
            );
          }
          outputLines.forEach(line => {
            console.log(line);
          });
          const html_output = outputLines
            .map(line => colors.stripColors(line))
            .join('\n');
          const data = s.lookback
            .slice(0, s.lookback.length - so.min_periods)
            .map(period => {
              return {
                time: period.time,
                open: period.open,
                high: period.high,
                low: period.low,
                close: period.close,
                volume: period.volume,
              };
            });
          let code = 'const data = ' + JSON.stringify(data) + ';\n';
          code += 'const trades = ' + JSON.stringify(s.my_trades) + ';\n';
          const tpl = fs.readFileSync(
            path.resolve(__dirname, '..', 'templates', 'sim_result.html.tpl'),
            { encoding: 'utf8' },
          );
          const out = tpl
            .replace('{{code}}', code)
            .replace('{{trend_ema_period}}', so.trend_ema || 36)
            .replace('{{output}}', html_output)
            .replace(
              /\{\{symbol\}\}/g,
              `${so.selector} - zenbot ${require('../package.json').version}`,
            );

          if (so.filename !== 'none') {
            const outTarget =
              so.filename ||
              `simulations/sim_result_${so.selector}_${new Date()
                .toISOString()
                .replace(/T/, '_')
                .replace(/\..+/, '')
                .replace(/-/g, '')
                .replace(/:/g, '')
                .replace(/20/, '')}_UTC.html`;
            fs.writeFileSync(outTarget, out);
            console.log('wrote', outTarget);
          }
          process.exit(0);
        }

        function getNext() {
          const opts = {
            query: {
              selector: so.selector,
            },
            sort: { time: 1 },
            limit: 1000,
          };
          if (so.end) {
            opts.query.time = { $lte: so.end };
          }
          if (cursor) {
            if (reversing) {
              opts.query.time = {};
              opts.query.time['$lt'] = cursor;
              if (queryStart) {
                opts.query.time['$gte'] = queryStart;
              }
              opts.sort = { time: -1 };
            } else {
              if (!opts.query.time) opts.query.time = {};
              opts.query.time['$gt'] = cursor;
            }
          } else if (queryStart) {
            if (!opts.query.time) opts.query.time = {};
            opts.query.time['$gte'] = queryStart;
          }
          get('db.trades').select(opts, (err, trades) => {
            if (err) throw err;
            if (!trades.length) {
              if (so.symmetrical && !reversing) {
                reversing = true;
                reversePoint = cursor;
                return getNext();
              }
              engine.exit(exitSim);
            }
            if (so.symmetrical && reversing) {
              trades.forEach(trade => {
                trade.orig_time = trade.time;
                trade.time = reversePoint + (reversePoint - trade.time);
              });
            }
            engine.update(trades, err2 => {
              if (err2) throw err2;
              if (reversing) {
                cursor = trades[trades.length - 1].orig_time;
              } else {
                cursor = trades[trades.length - 1].time;
              }
              setImmediate(getNext);
            });
          });
        }
        getNext();
      });
  };
};
