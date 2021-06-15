import {
  generateKeys,
  invalidMnemonicWords,
  normalizeMnemonic,
  suggestMnemonicCorrections,
  validateMnemonic,
} from '@celo/utils/lib/account'
import { privateKeyToAddress } from '@celo/utils/lib/address'
import * as bip39 from 'react-native-bip39'
import {
  all,
  call,
  cancel,
  delay,
  fork,
  join,
  put,
  race,
  select,
  spawn,
  takeLeading,
} from 'redux-saga/effects'
import { Task } from '@redux-saga/types'
import { setBackupCompleted } from 'src/account/actions'
import { uploadNameAndPicture } from 'src/account/profileInfo'
import { recoveringFromStoreWipeSelector } from 'src/account/selectors'
import { showError } from 'src/alert/actions'
import { AppEvents } from 'src/analytics/Events'
import ValoraAnalytics from 'src/analytics/ValoraAnalytics'
import { ErrorMessages } from 'src/app/ErrorMessages'
import { storeMnemonic } from 'src/backup/utils'
import { CURRENCY_ENUM } from 'src/geth/consts'
import { refreshAllBalances } from 'src/home/actions'
import {
  Actions,
  ImportBackupPhraseAction,
  importBackupPhraseFailure,
  importBackupPhraseSuccess,
} from 'src/import/actions'
import { redeemInviteSuccess } from 'src/invite/actions'
import { navigate, navigateClearingStack } from 'src/navigator/NavigationService'
import { Screens } from 'src/navigator/Screens'
import { fetchTokenBalanceInWeiWithRetry } from 'src/tokens/saga'
import Logger from 'src/utils/Logger'
import { assignAccountFromPrivateKey, waitWeb3LastBlock } from 'src/web3/saga'

const TAG = 'import/saga'

const MAX_BALANCE_CHECK_TASKS = 5
const MNEMONIC_AUTOCORRECT_TIMEOUT = 5000 // ms

export function* importBackupPhraseSaga({ phrase, useEmptyWallet }: ImportBackupPhraseAction) {
  Logger.debug(TAG + '@importBackupPhraseSaga', 'Importing backup phrase')
  yield call(waitWeb3LastBlock)
  try {
    const normalizedPhrase = normalizeMnemonic(phrase)
    const phraseIsValid = validateMnemonic(normalizedPhrase, bip39)

    // If the given mnemonic phrase is invalid, spend up to 1 second trying to correct it.
    // A balance check happens before the phrase is returned, so if the phrase was autocorrected,
    // we do not need to check the balance again later in this method.
    let mnemonic = phraseIsValid ? normalizedPhrase : undefined
    let checkedBalance = false
    if (!phraseIsValid) {
      const { correctedPhrase, timeout } = yield race({
        correctedPhrase: call(attemptBackupPhraseCorrection, normalizedPhrase),
        timeout: delay(MNEMONIC_AUTOCORRECT_TIMEOUT),
      })
      if (timeout) {
        Logger.info(TAG + '@importBackupPhraseSaga', 'Backup phrase autocorrection timed out')
      }
      if (correctedPhrase) {
        Logger.info(TAG + '@importBackupPhraseSaga', 'Using suggested mnemonic autocorrection')
        mnemonic = correctedPhrase
        checkedBalance = true
      }
    }

    // If the input phrase was invalid, and the correct phrase could not be found automatically,
    // report an error to the user.
    if (mnemonic === undefined) {
      Logger.error(TAG + '@importBackupPhraseSaga', 'Invalid mnemonic')
      const invalidWords = invalidMnemonicWords(normalizedPhrase)
      if (invalidWords.length > 0) {
        yield put(
          showError(ErrorMessages.INVALID_WORDS_IN_BACKUP_PHRASE, null, {
            invalidWords: invalidWords.join(', '),
          })
        )
      } else {
        yield put(showError(ErrorMessages.INVALID_BACKUP_PHRASE))
      }
      yield put(importBackupPhraseFailure())
      return
    }

    const { privateKey } = yield call(
      generateKeys,
      mnemonic,
      undefined,
      undefined,
      undefined,
      bip39
    )
    if (!privateKey) {
      throw new Error('Failed to convert mnemonic to hex')
    }

    // Check that the provided mnemonic derives an account with at least some balance. If the wallet
    // is empty, and useEmptyWallet is not true, display a warning to the user before they continue.
    if (!useEmptyWallet && !checkedBalance) {
      const backupAccount = privateKeyToAddress(privateKey)
      if (!(yield call(walletHasBalance, backupAccount))) {
        yield put(importBackupPhraseSuccess())
        navigate(Screens.ImportWallet, { clean: false, showZeroBalanceModal: true })
        return
      }
    }

    const account: string | null = yield call(assignAccountFromPrivateKey, privateKey, mnemonic)
    if (!account) {
      throw new Error('Failed to assign account from private key')
    }

    // Set key in phone's secure store
    yield call(storeMnemonic, mnemonic, account)
    // Set backup complete so user isn't prompted to do backup flow
    yield put(setBackupCompleted())
    // Set redeem invite complete so user isn't brought back into nux flow
    yield put(redeemInviteSuccess())
    yield put(refreshAllBalances())
    yield call(uploadNameAndPicture)

    const recoveringFromStoreWipe = yield select(recoveringFromStoreWipeSelector)
    if (recoveringFromStoreWipe) {
      ValoraAnalytics.track(AppEvents.redux_store_recovery_success, { account })
    }

    navigateClearingStack(Screens.VerificationEducationScreen)

    yield put(importBackupPhraseSuccess())
  } catch (error) {
    Logger.error(TAG + '@importBackupPhraseSaga', 'Error importing backup phrase', error)
    yield put(showError(ErrorMessages.IMPORT_BACKUP_FAILED))
    yield put(importBackupPhraseFailure())
  }
}

// Uses suggestMnemonicCorrections to generate valid mnemonic phrases that are likely given the
// invalid phrase that the user entered. Checks the balance of any phrase the generator suggests
// before returning it. If the wallet has non-zero balance, then we are be very confident that its
// the account the user was actually trying to restore. Otherwise, this method does not return any
// suggested correction.
function* attemptBackupPhraseCorrection(mnemonic: string) {
  // Counter of how many suggestions have been tried and a list of tasks for ongoing balance checks.
  let counter = 0
  let tasks: { index: number; suggestion: string; task: Task }[] = []
  for (const suggestion of suggestMnemonicCorrections(mnemonic)) {
    Logger.info(
      TAG + '@attemptBackupPhraseCorrection',
      `Checking account balance on suggestion #${++counter}`
    )
    const { privateKey } = yield call(
      generateKeys,
      suggestion,
      undefined,
      undefined,
      undefined,
      bip39
    )
    if (!privateKey) {
      Logger.error(TAG + '@attemptBackupPhraseCorrection', 'Failed to convert mnemonic to hex')
      continue
    }

    // Push a new check wallet balance task onto the list of running tasks.
    // If our list of tasks is full, wait for at least one to finish.
    tasks.push({
      index: counter,
      suggestion,
      task: yield fork(walletHasBalance, privateKeyToAddress(privateKey)),
    })
    if (tasks.length >= MAX_BALANCE_CHECK_TASKS) {
      yield race(tasks.map(({ task }) => join(task)))
    }

    // Check the results of any balance check tasks that have finished and prune any balance check
    // tasks from the list that are no longer running.
    const completed = tasks.filter(({ task }) => task.result() !== undefined)
    tasks = tasks.filter(({ task }) => task.isRunning())
    for (const task of completed) {
      if (task.task.result()) {
        Logger.info(
          TAG + '@attemptBackupPhraseCorrection',
          `Found correction phrase with balance in attempt ${task.index}`
        )
        cancel(tasks.map(({ task }) => task))
        return task.suggestion
      }
    }
  }
  return undefined
}

function* walletHasBalance(address: string) {
  Logger.debug(TAG + '@walletHasBalance', 'Checking account balance')
  const { dollarBalance, goldBalance } = yield all({
    dollarBalance: call(fetchTokenBalanceInWeiWithRetry, CURRENCY_ENUM.DOLLAR, address),
    goldBalance: call(fetchTokenBalanceInWeiWithRetry, CURRENCY_ENUM.GOLD, address),
  })

  return dollarBalance.isGreaterThan(0) || goldBalance.isGreaterThan(0)
}

export function* watchImportBackupPhrase() {
  yield takeLeading(Actions.IMPORT_BACKUP_PHRASE, importBackupPhraseSaga)
}

export function* importSaga() {
  yield spawn(watchImportBackupPhrase)
}
