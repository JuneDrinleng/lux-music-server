let status: LX.Sync.Status = {
  status: false,
  message: '',
  address: [],
  devices: [],
}

export const getServerStatus = (): LX.Sync.Status => status

export const setServerStatus = (nextStatus: LX.Sync.Status) => {
  status = nextStatus
}
