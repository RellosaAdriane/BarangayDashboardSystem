export default {
  roleName: 'Tanod',
  navHeading: 'FIELD MENU',
  description: 'Field view for assigned tasks, camera monitoring, alerts, and incident history.',
  canReport: false,
  canPublish: false,
  canAssignTasks: false,
  isAdmin: false,
  navigation: [
    ['▣', 'Live cameras', '#camera'],
    ['\u25b6', 'Past footage', '#recordedFootage'],
    ['⚠', 'Alerts', '#alerts'],
    ['▤', 'Incidents', '#incidents'],
    ['◷', 'Events calendar', '#eventsPanel'],
    ['✓', 'My tasks', '#tasksPanel']
  ]
};
