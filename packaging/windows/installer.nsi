; installer.nsi — extensión del template default de Tauri para Clawmint.
;
; Tauri genera un NSIS base; este archivo agrega:
;   1. Creación de %PROGRAMDATA%\Clawmint\{config,data,logs,models,mcps} con
;      permisos RW para el grupo "LocalService" (el service que correrá ahí).
;   2. Registro del Windows Service vía NSSM embebido en resources/nssm.exe.
;   3. Start automático del service al finalizar la instalación.
;   4. Uninstaller con prompt "¿borrar datos y config?" (default NO).
;
; NOTA: Tauri inyecta variables `${MAINBINARYNAME}`, `${BUNDLEID}`, etc. Este
; template se procesa a través del include system de Tauri.

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

; ── Config del paquete ──────────────────────────────────────────────────────
!define PRODUCT_NAME "Clawmint"
!define PRODUCT_PUBLISHER "Clawmint"
!define SERVICE_NAME "Clawmint"
!define SERVICE_DISPLAY_NAME "Clawmint Agent Service"
!define DATA_DIR "$PROGRAMDATA\Clawmint"

; ── Post-install: crear data dir + registrar service ────────────────────────
Section "RegisterService" SEC_SERVICE
  DetailPrint "Creando directorios de datos en ${DATA_DIR}..."
  CreateDirectory "${DATA_DIR}"
  CreateDirectory "${DATA_DIR}\config"
  CreateDirectory "${DATA_DIR}\data"
  CreateDirectory "${DATA_DIR}\data\memory"
  CreateDirectory "${DATA_DIR}\logs"
  CreateDirectory "${DATA_DIR}\models"
  CreateDirectory "${DATA_DIR}\mcps"

  ; Permisos RW para LocalService y LOCAL SERVICE account.
  ; icacls es built-in; /grant:r sobrescribe herencia.
  DetailPrint "Ajustando permisos para LocalService..."
  nsExec::ExecToLog 'icacls "${DATA_DIR}" /grant "NT AUTHORITY\LocalService":(OI)(CI)M /T'

  ; Registrar service con NSSM (embebido en $INSTDIR\resources\nssm.exe).
  ; El service ejecuta: node.exe <INSTDIR>\resources\server\index.js
  DetailPrint "Registrando Windows Service '${SERVICE_NAME}'..."
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" install ${SERVICE_NAME} "$INSTDIR\resources\node.exe" "$INSTDIR\resources\server\index.js"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SERVICE_NAME} DisplayName "${SERVICE_DISPLAY_NAME}"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SERVICE_NAME} Description "Clawmint agent server — backend para Telegram bots y panel web"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SERVICE_NAME} Start SERVICE_DELAYED_AUTO_START'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SERVICE_NAME} ObjectName "NT AUTHORITY\LocalService"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SERVICE_NAME} AppEnvironmentExtra "CLAWMINT_DATA_DIR=${DATA_DIR}" "CLAWMINT_RESOURCES_DIR=$INSTDIR\resources" "NODE_OPTIONS=--stack-size=65536"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SERVICE_NAME} AppStdout "${DATA_DIR}\logs\service.log"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SERVICE_NAME} AppStderr "${DATA_DIR}\logs\service.err.log"'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SERVICE_NAME} AppRotateFiles 1'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" set ${SERVICE_NAME} AppRotateBytes 10485760'

  ; Iniciar el service ahora.
  DetailPrint "Iniciando Clawmint service..."
  nsExec::ExecToLog 'sc start ${SERVICE_NAME}'
SectionEnd

; ── Uninstaller ──────────────────────────────────────────────────────────────
Section "Uninstall"
  DetailPrint "Deteniendo y removiendo service..."
  nsExec::ExecToLog 'sc stop ${SERVICE_NAME}'
  nsExec::ExecToLog '"$INSTDIR\resources\nssm.exe" remove ${SERVICE_NAME} confirm'

  ; Prompt para borrar datos
  MessageBox MB_YESNO|MB_ICONQUESTION "¿Borrar también tus datos y configuración en ${DATA_DIR}? Esto eliminará bots, historial y API keys de forma permanente." IDNO SkipDataDelete
    RMDir /r "${DATA_DIR}"
  SkipDataDelete:
SectionEnd
