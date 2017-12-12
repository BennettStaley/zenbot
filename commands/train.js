const tb = require('timebucket');
const minimist = require('minimist');
const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;
const moment = require('moment');
const analytics = require('forex.analytics');
const ProgressBar = require('progress');
const crypto = require('crypto');

const defaultIndicators = ['CCI', 'MACD', 'RSI', 'SAR', 'Stochastic'];

const availableIndicators = [
  'ATR',
  'BOP',
  'CCI',
  'MACD',
  'MACD_Signal',
  'MACD_Histogram',
  'Momentum',
  'RSI',
  'SAR',
  'SMA15_SMA50',
  'Stochastic',
];

const getTrainOptions = so => {
  const item = so || {};

  return {
    populationCount: item.populationCount || 100,
    generationCount: item.generationCount || 100,
    selectionAmount: item.selectionAmount || 10,
    leafValueMutationProbability: item.leafValueMutationProbability || 0.5,
    leafSignMutationProbability: item.leafSignMutationProbability || 0.3,
    logicalNodeMutationProbability: item.logicalNodeMutationProbability || 0.3,
    leafIndicatorMutationProbability:
      item.leafIndicatorMutationProbability || 0.2,
    crossoverProbability: item.crossoverProbability || 0.03,
    indicators: item.indicators
      ? item.indicators.split(',')
      : defaultIndicators,
  };
};

module.exports = function container(get, set) {
  const c = get('conf');

  return program => {
    program
      .command('train [selector]')
      .allowUnknownOption()
      .description(
        'Train the binary buy/sell decision tree for the forex.analytics strategy',
      )
      .option('--conf <path>', 'path to optional conf overrides file')
      .option(
        '--period <value>',
        'period length of a candlestick (default: 30m)',
        String,
        '30m',
      )
      .option('--start_training <timestamp>', 'start training at timestamp')
      .option('--end_training <timestamp>', 'end training at timestamp')
      .option(
        '--days_training <days>',
        'set duration of training dataset by day count',
        Number,
        c.days,
      )
      .option(
        '--days_test <days>',
        'set duration of test dataset to use with simulation, appended AFTER the training dataset (default: 0)',
        Number,
      )
      .option(
        '--populationCount <value>',
        'population count within one generation (default: ' +
          getTrainOptions().populationCount +
          ')',
        Number,
      )
      .option(
        '--generationCount <value>',
        'generation count (default: ' + getTrainOptions().generationCount + ')',
        Number,
      )
      .option(
        '--selectionAmount <value>',
        'how many chromosomes shall be selected from the old generation when constructing a new one (default: ' +
          getTrainOptions().selectionAmount +
          ')',
        Number,
      )
      .option(
        '--leafValueMutationProbability <value>',
        'leaf value mutation probability (default: ' +
          getTrainOptions().leafValueMutationProbability +
          ')',
        Number,
      )
      .option(
        '--leafSignMutationProbability <value>',
        'leaf sign mutation probability (default: ' +
          getTrainOptions().leafSignMutationProbability +
          ')',
        Number,
      )
      .option(
        '--logicalNodeMutationProbability <value>',
        'logical node mutation probability (default: ' +
          getTrainOptions().logicalNodeMutationProbability +
          ')',
        Number,
      )
      .option(
        '--leafIndicatorMutationProbability <value>',
        'leaf indicator mutation probability (default: ' +
          getTrainOptions().leafIndicatorMutationProbability +
          ')',
        Number,
      )
      .option(
        '--crossoverProbability <value>',
        'crossover probability (default: ' +
          getTrainOptions().crossoverProbability +
          ')',
        Number,
      )
      .option(
        '--indicators <value>',
        'comma separated list of TA-lib indicators (default: ' +
          defaultIndicators.toString() +
          ', available: ' +
          availableIndicators.toString() +
          ')',
        String,
      )

      .action((selector, cmd) => {
        const s = { options: minimist(process.argv) };
        const so = s.options;
        delete so._;
        Object.keys(c).forEach(k => {
          if (typeof cmd[k] !== 'undefined') {
            so[k] = cmd[k];
          }
        });

        if (!so.days_test) {
          so.days_test = 0;
        }
        so.strategy = 'noop';

        const unknownIndicators = [];
        if (so.indicators) {
          so.indicators.split(',').forEach(indicator => {
            if (!availableIndicators.includes(indicator)) {
              unknownIndicators.push(indicator);
            }
          });
        }
        if (unknownIndicators.length > 0) {
          console.error(
            'ERROR: The following indicators are not in forex.analytics: '.red +
              unknownIndicators.toString().yellow,
          );
          console.error(
            'Available indicators: ' + availableIndicators.toString(),
          );
          process.exit(1);
        }

        if (so.start_training) {
          so.start_training = moment(so.start_training).valueOf();
          if (so.days_training && !so.end_training) {
            so.end_training = tb(so.start_training)
              .resize('1d')
              .add(so.days_training)
              .toMilliseconds();
          }
        }
        if (so.end_training) {
          so.end_training = moment(so.end_training).valueOf();
          if (so.days_training && !so.start_training) {
            so.start_training = tb(so.end_training)
              .resize('1d')
              .subtract(so.days_training)
              .toMilliseconds();
          }
        }
        if (!so.start_training && so.days_training) {
          const d = tb('1d');
          so.start_training = d
            .subtract(so.days_test)
            .subtract(so.days_training)
            .toMilliseconds();
        }
        if (so.days_test > 0) {
          const d = tb('1d');
          so.end_training = d.subtract(so.days_test).toMilliseconds();
        }
        so.selector = get('lib.normalize-selector')(selector || c.selector);
        so.mode = 'train';
        if (cmd.conf) {
          const overrides = require(path.resolve(process.cwd(), cmd.conf));
          Object.keys(overrides).forEach(function(k) {
            so[k] = overrides[k];
          });
        }
        const engine = get('lib.engine')(s);

        if (!so.min_periods) so.min_periods = 1;
        let cursor;
        let reversing;
        let reversePoint;
        const queryStart = so.start_training
          ? tb(so.start_training)
              .resize(so.period)
              .subtract(so.min_periods + 2)
              .toMilliseconds()
          : null;

        function writeTempModel(strategy) {
          const tempModelString = JSON.stringify(
            {
              selector: so.selector,
              period: so.period,
              start_training: moment(so.start_training),
              end_training: moment(so.end_training),
              options: getTrainOptions(so),
              strategy: strategy,
            },
            null,
            4,
          );

          const tempModelHash = crypto
            .createHash('sha256')
            .update(tempModelString)
            .digest('hex');
          const tempModelFile =
            'models/temp.' +
            tempModelHash +
            '-' +
            moment(so.start_training)
              .utc()
              .format('YYYYMMDD_HHmmssZZ') +
            '.json';

          fs.writeFileSync(tempModelFile, tempModelString);

          return tempModelFile;
        }

        function writeFinalModel(
          strategy,
          end_training,
          trainingResult,
          testResult,
        ) {
          const finalModelString = JSON.stringify(
            {
              selector: so.selector,
              period: so.period,
              start_training: moment(so.start_training).utc(),
              end_training: moment(end_training).utc(),
              result_training: trainingResult,
              start_test:
                so.days_test > 0 ? moment(end_training).utc() : undefined,
              result_test: testResult,
              options: getTrainOptions(so),
              strategy: strategy,
            },
            null,
            4,
          );

          const testVsBuyHold =
            typeof testResult !== 'undefined' ? testResult.vsBuyHold : 'noTest';

          const finalModelFile =
            'models/forex.model_' +
            so.selector +
            '_period=' +
            so.period +
            '_from=' +
            moment(so.start_training)
              .utc()
              .format('YYYYMMDD_HHmmssZZ') +
            '_to=' +
            moment(end_training)
              .utc()
              .format('YYYYMMDD_HHmmssZZ') +
            '_trainingVsBuyHold=' +
            trainingResult.vsBuyHold +
            '_testVsBuyHold=' +
            testVsBuyHold +
            '_created=' +
            moment()
              .utc()
              .format('YYYYMMDD_HHmmssZZ') +
            '.json';

          fs.writeFileSync(finalModelFile, finalModelString);

          return finalModelFile;
        }

        function parseSimulation(simulationResultFile) {
          const endBalance = new RegExp(/end balance: .* \((.*)%\)/);
          const buyHold = new RegExp(/buy hold: .* \((.*)%\)/);
          const vsBuyHold = new RegExp(/vs\. buy hold: (.*)%/);
          const trades = new RegExp(
            /([0-9].* trades over .* days \(avg (.*) trades\/day\))/,
          );
          const errorRate = new RegExp(/error rate: (.*)%/);

          let simulationResult = fs
            .readFileSync(simulationResultFile)
            .toString();
          simulationResult = simulationResult.substr(
            simulationResult.length - 512,
          );

          const result = {};
          if (simulationResult.match(endBalance)) {
            result.endBalance = simulationResult.match(endBalance)[1];
          }
          if (simulationResult.match(buyHold)) {
            result.buyHold = simulationResult.match(buyHold)[1];
          }
          if (simulationResult.match(vsBuyHold)) {
            result.vsBuyHold = simulationResult.match(vsBuyHold)[1];
          }
          if (simulationResult.match(trades)) {
            result.trades = simulationResult.match(trades)[1];
            result.avgTradesPerDay = simulationResult.match(trades)[2];
          }
          if (simulationResult.match(errorRate)) {
            result.errorRate = simulationResult.match(errorRate)[1];
          }

          return result;
        }

        function trainingDone(strategy, lastPeriod) {
          const tempModelFile = writeTempModel(strategy);
          console.log('\nModel temporarily written to ' + tempModelFile);

          if (typeof so.end_training === 'undefined') {
            so.end_training = lastPeriod.time * 1000;
          }

          console.log(
            '\nRunning simulation on training data from ' +
              moment(so.start_training).format('YYYY-MM-DD HH:mm:ss ZZ') +
              ' to ' +
              moment(so.end_training).format('YYYY-MM-DD HH:mm:ss ZZ') +
              '.\n',
          );

          const zenbot_cmd =
            process.platform === 'win32' ? 'zenbot.bat' : 'zenbot.sh'; // Use 'win32' for 64 bit windows too
          const trainingArgs = [
            'sim',
            so.selector,
            '--strategy',
            'forex_analytics',
            '--disable_options',
            '--modelfile',
            path.resolve(__dirname, '..', tempModelFile),
            '--start',
            so.start_training,
            '--end',
            so.end_training,
            '--period',
            so.period,
            '--filename',
            path.resolve(__dirname, '..', tempModelFile) +
              '-simTrainingResult.html',
          ];
          const trainingSimulation = spawn(
            path.resolve(__dirname, '..', zenbot_cmd),
            trainingArgs,
            { stdio: 'inherit' },
          );

          trainingSimulation.on('exit', (trainCode, trainSignal) => {
            if (trainCode) {
              console.log(
                'Child process exited with trainCode ' +
                  trainCode +
                  ' and trainSignal ' +
                  trainSignal,
              );
              process.exit(trainCode);
            }

            const trainingResult = parseSimulation(
              path.resolve(__dirname, '..', tempModelFile) +
                '-simTrainingResult.html',
            );

            if (so.days_test > 0) {
              console.log(
                '\nRunning simulation on test data from ' +
                  moment(so.end_training).format('YYYY-MM-DD HH:mm:ss ZZ') +
                  ' onwards.\n',
              );

              const testArgs = [
                'sim',
                so.selector,
                '--strategy',
                'forex_analytics',
                '--disable_options',
                '--modelfile',
                path.resolve(__dirname, '..', tempModelFile),
                '--start',
                so.end_training,
                '--period',
                so.period,
                '--filename',
                path.resolve(__dirname, '..', tempModelFile) +
                  '-simTestResult.html',
              ];
              const testSimulation = spawn(
                path.resolve(__dirname, '..', zenbot_cmd),
                testArgs,
                { stdio: 'inherit' },
              );

              testSimulation.on('exit', (testCode, testSignal) => {
                if (testCode) {
                  console.log(
                    'Child process exited with testCode ' +
                      testCode +
                      ' and testSignal ' +
                      testSignal,
                  );
                }

                const testResult = parseSimulation(
                  path.resolve(__dirname, '..', tempModelFile) +
                    '-simTestResult.html',
                );

                const finalModelFile = writeFinalModel(
                  strategy,
                  so.end_training,
                  trainingResult,
                  testResult,
                );
                fs.rename(
                  path.resolve(__dirname, '..', tempModelFile) +
                    '-simTrainingResult.html',
                  path.resolve(__dirname, '..', finalModelFile) +
                    '-simTrainingResult.html',
                );
                fs.rename(
                  path.resolve(__dirname, '..', tempModelFile) +
                    '-simTestResult.html',
                  path.resolve(__dirname, '..', finalModelFile) +
                    '-simTestResult.html',
                );
                fs.unlink(path.resolve(__dirname, '..', tempModelFile));
                console.log(
                  '\nFinal model with results written to ' + finalModelFile,
                );

                process.exit(0);
              });
            } else {
              const finalModelFile = writeFinalModel(
                strategy,
                so.end_training,
                trainingResult,
                undefined,
              );
              fs.rename(
                path.resolve(__dirname, '..', tempModelFile) +
                  '-simTrainingResult.html',
                path.resolve(__dirname, '..', finalModelFile) +
                  '-simTrainingResult.html',
              );
              fs.unlink(path.resolve(__dirname, '..', tempModelFile));
              console.log(
                '\nFinal model with results written to ' + finalModelFile,
              );

              process.exit(0);
            }
          });
        }

        function createStrategy(candlesticks) {
          const bar = new ProgressBar(
            'Training [:bar] :percent :etas - Fitness: :fitness',
            {
              width: 80,
              total: getTrainOptions(so).generationCount,
              incomplete: ' ',
            },
          );

          return analytics.findStrategy(
            candlesticks,
            getTrainOptions(so),
            (strategy, fitness) => {
              bar.tick({
                fitness,
              });
            },
          );
        }

        function createCandlesticks() {
          console.log();

          if (!s.period) {
            console.error(
              'no trades found! try running `zenbot backfill ' +
                so.selector +
                '` first',
            );
            process.exit(1);
          }

          const optionKeys = Object.keys(so);
          optionKeys.sort((a, b) => {
            if (a < b) return -1;
            return 1;
          });
          const options = {};
          optionKeys.forEach(k => {
            options[k] = so[k];
          });

          const candlesticks = [];
          s.lookback.unshift(s.period);
          s.lookback
            .slice(0, s.lookback.length - so.min_periods)
            .map(period => {
              const candlestick = {
                open: period.open,
                high: period.high,
                low: period.low,
                close: period.close,
                time: period.time / 1000,
              };
              return candlesticks.unshift(candlestick);
            });

          createStrategy(candlesticks)
            .then(strategy => {
              trainingDone(strategy, candlesticks[candlesticks.length - 1]);
            })
            .catch(err => {
              console.log('Training error. Aborting.'.red);
              console.log(err);
              process.exit(1);
            });
        }

        function getTrades() {
          const opts = {
            query: {
              selector: so.selector,
            },
            sort: { time: 1 },
            limit: 1000,
          };
          if (so.end_training) {
            opts.query.time = { $lte: so.end_training };
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
                return getTrades();
              }
              return createCandlesticks();
            }
            if (so.symmetrical && reversing) {
              trades.forEach(trade => {
                trade.orig_time = trade.time;
                trade.time = reversePoint + (reversePoint - trade.time);
              });
            }
            engine.update(trades, err => {
              if (err) throw err;
              cursor = trades[trades.length - 1].time;
              setImmediate(getTrades);
            });
          });
        }

        console.log('Generating training candlesticks from database...');
        getTrades();
      });
  };
};
